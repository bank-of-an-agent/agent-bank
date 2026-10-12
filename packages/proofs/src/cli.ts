import { ProofInputError, ProofRefusedError, ProofRequestError } from "./errors";
import { toBytes32 } from "./field";
import { prove } from "./prover";
import { generateProofSecret, identityCommitment, parseSecret } from "./tree";

/**
 * `agentbank-prove`: the prover as a process, for SDKs that cannot run the circuit's
 * WebAssembly witness generator themselves (the Python SDK).
 *
 *   agentbank-prove [prove]   stdin { secret, witness, request }  → stdout presentation JSON
 *   agentbank-prove identity  stdin { secret } or nothing          → stdout { secret, identity_commitment }
 *
 * Exit codes: 0 success; 1 internal error; 2 invalid input (usage, JSON, schema); 3 refused
 * (the witness cannot prove the request). Errors are one JSON line on stderr:
 * `{"error": "invalid_input" | "refused" | "internal", "message", ...}`; refusals add
 * `reason` (unsatisfiable | undisclosed | witness_mismatch | chain_mismatch), `attributes` and
 * `undisclosed_classes`.
 */

export const EXIT = { ok: 0, internal: 1, invalidInput: 2, refused: 3 } as const;

export const USAGE = `Usage: agentbank-prove [prove | identity]

  prove (default)  Read {"secret", "witness", "request"} JSON on stdin and write the
                   presentation JSON (agentbank.proof.v1) on stdout.
  identity         Read {"secret"} JSON on stdin (or nothing, to generate a fresh secret) and
                   write {"secret", "identity_commitment"} on stdout.

Exit codes: 0 ok, 1 internal error, 2 invalid input, 3 refused (cannot prove this request).
Errors are a JSON line on stderr.
`;

export interface CliIo {
  /** All of stdin, or null when stdin is a terminal (nothing piped). */
  readStdin(): Promise<string | null>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export function nodeIo(): CliIo {
  return {
    async readStdin() {
      if (process.stdin.isTTY) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  };
}

class InvalidInput extends Error {}

function parseJsonObject(text: string | null, what: string): Record<string, unknown> {
  if (text === null || text.trim() === "") throw new InvalidInput(`expected ${what} JSON on stdin`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidInput("stdin is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInput(`expected a JSON object with ${what}`);
  }
  return value as Record<string, unknown>;
}

async function runProve(io: CliIo): Promise<void> {
  const input = parseJsonObject(await io.readStdin(), '"secret", "witness" and "request"');
  for (const field of ["secret", "witness", "request"]) {
    if (input[field] === undefined) throw new InvalidInput(`missing "${field}"`);
  }
  if (typeof input.secret !== "string") throw new InvalidInput('"secret" must be a 0x hex string');
  const presentation = await prove({ secret: input.secret, witness: input.witness, request: input.request });
  io.stdout(`${JSON.stringify(presentation)}\n`);
}

async function runIdentity(io: CliIo): Promise<void> {
  const text = await io.readStdin();
  let secret: string;
  if (text === null || text.trim() === "") secret = generateProofSecret();
  else {
    const input = parseJsonObject(text, '"secret"');
    if (typeof input.secret !== "string") throw new InvalidInput('"secret" must be a 0x hex string');
    try {
      secret = toBytes32(parseSecret(input.secret));
    } catch (error) {
      throw new InvalidInput(`invalid secret: ${(error as Error).message}`);
    }
  }
  const identity = toBytes32(identityCommitment(secret));
  io.stdout(`${JSON.stringify({ secret, identity_commitment: identity })}\n`);
}

function report(io: CliIo, body: Record<string, unknown>): void {
  io.stderr(`${JSON.stringify(body)}\n`);
}

/** Run the CLI; resolves to the exit code. */
export async function main(argv: readonly string[], io: CliIo = nodeIo()): Promise<number> {
  const [command = "prove", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if ((command !== "prove" && command !== "identity") || rest.length > 0) {
    report(io, { error: "invalid_input", message: `unknown arguments: ${argv.join(" ")}` });
    io.stderr(USAGE);
    return EXIT.invalidInput;
  }
  try {
    if (command === "identity") await runIdentity(io);
    else await runProve(io);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof ProofRefusedError) {
      report(io, {
        error: "refused",
        reason: error.reason,
        message: error.message,
        attributes: error.attributes,
        undisclosed_classes: error.undisclosedClasses,
      });
      return EXIT.refused;
    }
    if (
      error instanceof InvalidInput ||
      error instanceof ProofInputError ||
      error instanceof ProofRequestError
    ) {
      report(io, { error: "invalid_input", message: error.message });
      return EXIT.invalidInput;
    }
    report(io, { error: "internal", message: (error as Error).message });
    return EXIT.internal;
  }
}
