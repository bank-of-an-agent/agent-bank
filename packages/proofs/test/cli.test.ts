import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, main, nodeIo, USAGE, type CliIo } from "../src/cli";
import { fromBytes32, toBytes32 } from "../src/field";
import { balanceAtLeast, verifiedCompany } from "../src/request";
import { identityCommitment } from "../src/tree";
import { releaseProverResources, verifyPresentation } from "../src/verifier";
import { AGENT_SECRET, buildFixture, NOW, standardRequest } from "./fixtures";

const BIN = fileURLToPath(new URL("../bin/agentbank-prove.mjs", import.meta.url));
const fixture = buildFixture();

function io(stdin: string | null): CliIo & { out: string; err: string } {
  const state = {
    out: "",
    err: "",
    readStdin: async () => stdin,
    stdout: (text: string) => void (state.out += text),
    stderr: (text: string) => void (state.err += text),
  };
  return state;
}

afterAll(releaseProverResources);
afterEach(() => vi.restoreAllMocks());

describe("agentbank-prove (in process)", () => {
  it("prints usage", async () => {
    const help = io(null);
    expect(await main(["--help"], help)).toBe(EXIT.ok);
    expect(help.out).toBe(USAGE);
    const bad = io(null);
    expect(await main(["prove", "extra"], bad)).toBe(EXIT.invalidInput);
    expect(JSON.parse(bad.err.split("\n")[0] as string)).toMatchObject({ error: "invalid_input" });
  });

  it("derives identity commitments, generating a secret when none is piped", async () => {
    const given = io(JSON.stringify({ secret: "0x075bcd15" }));
    expect(await main(["identity"], given)).toBe(EXIT.ok);
    expect(JSON.parse(given.out)).toEqual({
      secret: toBytes32(123456789n),
      identity_commitment: toBytes32(identityCommitment(123456789n)),
    });
    for (const stdin of [null, "  \n"]) {
      const fresh = io(stdin);
      expect(await main(["identity"], fresh)).toBe(EXIT.ok);
      const out = JSON.parse(fresh.out) as { secret: string; identity_commitment: string };
      expect(out.secret).toMatch(/^0x00[0-9a-f]{62}$/);
      expect(fromBytes32(out.identity_commitment)).toBe(identityCommitment(out.secret));
    }
    for (const stdin of ['{"secret": 5}', '{"secret": "0x0"}', "[1]", "nope"]) {
      const bad = io(stdin);
      expect(await main(["identity"], bad)).toBe(EXIT.invalidInput);
      expect(JSON.parse(bad.err)).toMatchObject({ error: "invalid_input" });
    }
  });

  it("rejects malformed prove input", async () => {
    const cases = [
      null,
      "",
      "{",
      '"text"',
      JSON.stringify({ secret: AGENT_SECRET, witness: fixture.baseWitness }),
      JSON.stringify({ secret: 1, witness: fixture.baseWitness, request: standardRequest() }),
      JSON.stringify({ secret: AGENT_SECRET, witness: {}, request: standardRequest() }),
      JSON.stringify({ secret: AGENT_SECRET, witness: fixture.baseWitness, request: { type: "x" } }),
    ];
    for (const stdin of cases) {
      const run = io(stdin);
      expect(await main([], run), String(stdin)).toBe(EXIT.invalidInput);
      expect(JSON.parse(run.err).error).toBe("invalid_input");
    }
  });

  it("refuses with exit code 3 and the failing attributes", async () => {
    const run = io(
      JSON.stringify({
        secret: AGENT_SECRET,
        witness: fixture.baseWitness,
        request: standardRequest({ require: [verifiedCompany(), balanceAtLeast("9999")] }),
      }),
    );
    expect(await main(["prove"], run)).toBe(EXIT.refused);
    expect(JSON.parse(run.err)).toMatchObject({
      error: "refused",
      reason: "unsatisfiable",
      attributes: ["balance"],
      undisclosed_classes: [],
    });
  });

  it("proves, writing the presentation JSON to stdout", async () => {
    const request = standardRequest();
    const run = io(JSON.stringify({ secret: AGENT_SECRET, witness: fixture.baseWitness, request }));
    expect(await main([], run)).toBe(EXIT.ok);
    expect(run.err).toBe("");
    const presentation = JSON.parse(run.out);
    const result = await verifyPresentation({ request, presentation, rootInfo: fixture.rootInfo, now: NOW });
    expect(result.valid).toBe(true);
  });

  it("reads stdin and writes stdout through Node streams", async () => {
    const stdin = Object.assign(Readable.from([Buffer.from('{"secret":'), Buffer.from('"0x01"}')]), {
      isTTY: false,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as never);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as never);
    const node = nodeIo();
    expect(await node.readStdin()).toBe('{"secret":"0x01"}');
    node.stdout("out");
    node.stderr("err");
    expect(writes).toEqual(["out", "err"]);
    vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as never);
    expect(await nodeIo().readStdin()).toBeNull();
  });
});

function run(
  args: string[],
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: "/", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe("agentbank-prove (end to end, from any directory)", () => {
  it("proves, refuses and derives identities as a process", async () => {
    const request = standardRequest();
    const proved = await run(
      [],
      JSON.stringify({ secret: AGENT_SECRET, witness: fixture.baseWitness, request }),
    );
    expect(proved.code).toBe(0);
    const result = await verifyPresentation({
      request,
      presentation: JSON.parse(proved.stdout),
      rootInfo: fixture.rootInfo,
      now: NOW,
    });
    expect(result.valid).toBe(true);

    const refused = await run(
      ["prove"],
      JSON.stringify({ secret: toBytes32(42n), witness: fixture.baseWitness, request }),
    );
    expect(refused.code).toBe(3);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: "refused", reason: "witness_mismatch" });

    const identity = await run(["identity"], "");
    expect(identity.code).toBe(0);
    expect(JSON.parse(identity.stdout).identity_commitment).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
