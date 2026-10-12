import type * as ProofHttp from "./http";
import type * as NodeProver from "../prover";

/**
 * Lazily loaded parts of private proofs, so `@agentbank/sdk` itself loads neither snarkjs nor
 * Node built-ins: the HTTP header helpers (on the first proof challenge) and the Node prover
 * (on the first proof). A failed load is retried on the next call.
 */

let http: Promise<typeof ProofHttp> | undefined;
let nodeProver: Promise<typeof NodeProver> | undefined;

export async function loadProofHttp(): Promise<typeof ProofHttp> {
  http ??= import("./http");
  try {
    return await http;
  } catch (error) {
    http = undefined;
    throw error;
  }
}

/**
 * Where the Node prover (`@agentbank/sdk/prover`) is, relative to this module and worked out at
 * run time, so that bundlers never pull it (with its circuit-file lookup and Node built-ins)
 * into an app's graph: `./prover.js` (or `./prover.cjs`) next to the chunk in a build of the SDK
 * (or of a bundle that ships it, like the MCP server), `../prover.ts` in a source checkout.
 * Undefined when this code does not run from a file (browsers, bundles evaluated in memory).
 */
function nodeProverSpecifier(): string | undefined {
  let here: unknown;
  try {
    here = import.meta.url;
  } catch {
    return undefined;
  }
  if (typeof here !== "string" || !here.startsWith("file:")) return undefined;
  if (/\.[cm]?tsx?$/.test(here)) return "../prover.ts";
  return here.endsWith(".cjs") ? "./prover.cjs" : "./prover.js";
}

export async function loadNodeProver(): Promise<typeof NodeProver> {
  nodeProver ??= (async () => {
    const specifier = nodeProverSpecifier();
    if (specifier === undefined) throw new Error("the Node prover is only available in Node");
    const loaded = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ specifier
    )) as typeof NodeProver & { default?: typeof NodeProver };
    // A CommonJS build is imported as a namespace whose default export is module.exports.
    return typeof loaded.prove === "function" ? loaded : (loaded.default as typeof NodeProver);
  })();
  try {
    return await nodeProver;
  } catch (error) {
    nodeProver = undefined;
    throw error;
  }
}

/** Whether the Node prover was loaded (so there may be prover resources to release). */
export function nodeProverLoaded(): Promise<typeof NodeProver> | undefined {
  return nodeProver;
}
