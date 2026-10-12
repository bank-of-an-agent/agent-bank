#!/usr/bin/env node
// agentbank-prove: runs the TypeScript CLI (src/cli.ts) straight from a checkout, no build step.
//   node packages/proofs/bin/agentbank-prove.mjs [prove|identity] < input.json
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
const { releaseProverResources } = await import("../src/verifier.ts");
const code = await main(process.argv.slice(2));
await releaseProverResources();
process.exitCode = code;
