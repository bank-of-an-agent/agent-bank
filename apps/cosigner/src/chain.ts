import {
  anvilForkContracts,
  baseSepoliaContracts,
  checkPreparedOperation,
  decodePreparedOperation,
  hashUserOperation,
  SIMULATED_CONTRACTS,
  withAgentBankContracts,
  type ChainContracts,
  type PreparedOperation,
} from "@agentbank/chain";
import type { CosignerConfig } from "./config";
import type { OperationCodec } from "./operation";

/**
 * The co-signer only re-derives operations, it never talks to the chain: a
 * codec built from the same pure hash and decode functions every
 * `ChainGateway` uses, for the chain's contract set. No RPC endpoint, no
 * network dependency in the signing path.
 */
export function operationCodec(chainId: number, contracts: ChainContracts): OperationCodec {
  const gateway = { chainId, contracts };
  return {
    chainId,
    contracts,
    hashOperation(op: PreparedOperation) {
      const userOp = checkPreparedOperation(op, gateway);
      return hashUserOperation(userOp, op.chainId, op.entryPoint);
    },
    decodeOperation(op: PreparedOperation) {
      checkPreparedOperation(op, gateway);
      return decodePreparedOperation(op, contracts);
    },
  };
}

/** Contracts for the configured chain, with Agent Bank's deployed contracts (`COSIGNER_CONTRACTS`) filled in. */
export function contractsFor(config: Pick<CosignerConfig, "chain" | "contracts">): ChainContracts {
  const base =
    config.chain.name === "simulated"
      ? SIMULATED_CONTRACTS
      : config.chain.name === "anvil"
        ? anvilForkContracts()
        : baseSepoliaContracts();
  return withAgentBankContracts(base, config.contracts);
}

export function createOperationCodec(config: Pick<CosignerConfig, "chain" | "contracts">): OperationCodec {
  return operationCodec(config.chain.id, contractsFor(config));
}
