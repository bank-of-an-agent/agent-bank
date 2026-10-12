import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
} from "viem";
import {
  agentEscrowAbi,
  agentPolicyHookAbi,
  contractsFromDeployment,
  erc20Abi,
  baseSepoliaContracts,
  paymentStreamsAbi,
  policyConfigParams,
  sweepExecutorAbi,
  timeLockVaultsAbi,
  topUpExecutorAbi,
  type AgentBankDeploymentFile,
} from "../src";

const dir = join(__dirname, "../src/abis");

function load(name: string): Abi | null {
  const file = join(dir, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Abi) : null;
}

function canonical(params: readonly AbiParameter[]): string {
  return params
    .map((p) =>
      "components" in p && p.components
        ? `(${canonical(p.components)})${p.type.slice("tuple".length)}`
        : p.type,
    )
    .join(",");
}

function check(name: string, typed: Abi): void {
  const full = load(name);
  it.skipIf(full === null)(`${name}: every typed item exists in the contract ABI with the same shape`, () => {
    const abi = full as Abi;
    for (const item of typed) {
      if (item.type === "function") {
        const match = abi.find(
          (x): x is AbiFunction =>
            x.type === "function" && toFunctionSelector(x) === toFunctionSelector(item),
        );
        expect(match, `${name}.${item.name}(${canonical(item.inputs)})`).toBeDefined();
        expect(canonical(match?.outputs ?? []), `${name}.${item.name} outputs`).toBe(canonical(item.outputs));
      } else if (item.type === "event") {
        const match = abi.find(
          (x): x is AbiEvent => x.type === "event" && toEventSelector(x) === toEventSelector(item),
        );
        expect(match, `${name} event ${item.name}`).toBeDefined();
        expect(
          match?.inputs.map((i) => Boolean(i.indexed)),
          `${name} event ${item.name} indexed`,
        ).toEqual(item.inputs.map((i) => Boolean(i.indexed)));
        expect(match?.inputs.map((i) => i.name)).toEqual(item.inputs.map((i) => i.name));
      }
    }
  });
}

describe("typed ABIs match the contracts repository's exported ABIs", () => {
  check("AgentEscrow", agentEscrowAbi);
  check("PaymentStreams", paymentStreamsAbi);
  check("TimeLockVaults", timeLockVaultsAbi);
  check("AgentPolicyHook", agentPolicyHookAbi);
  check("TopUpExecutor", topUpExecutorAbi);
  check("SweepExecutor", sweepExecutorAbi);
  // MockUSDC mirrors FiatToken v2.2 on Anvil: our whole USDC surface must exist there too.
  check("MockUSDC", erc20Abi);

  it.skipIf(load("AgentPolicyHook") === null)("PolicyConfig encoding matches applyConfig's parameter", () => {
    const apply = (load("AgentPolicyHook") as Abi).find(
      (x): x is AbiFunction => x.type === "function" && x.name === "applyConfig",
    ) as AbiFunction;
    expect(canonical(apply.inputs)).toBe(canonical(policyConfigParams));
  });
});

describe("deployment files", () => {
  const files = existsSync(join(dir, "deployments")) ? readdirSync(join(dir, "deployments")) : [];
  it.skipIf(files.length === 0)("load into ChainContracts", () => {
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      const file = JSON.parse(readFileSync(join(dir, "deployments", f), "utf8")) as AgentBankDeploymentFile;
      const contracts = contractsFromDeployment(baseSepoliaContracts(), file, { useDeploymentUsdc: false });
      expect(contracts.escrow).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(contracts.policyHook).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(contracts.usdc).toBe(baseSepoliaContracts().usdc);
    }
  });
});
