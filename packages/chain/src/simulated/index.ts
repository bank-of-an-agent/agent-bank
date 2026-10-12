/**
 * `@agentbank/chain/simulated`: the in-memory {@link SimulatedChain} (deterministic, no network)
 * whose `gateway` implements `ChainGateway` with production's validation rules.
 */
export {
  SimulatedChain,
  SIMULATED_FAUCET,
  SIMULATED_PAYMASTER,
  SIMULATED_RELAYER,
  type ReorgOptions,
  type ReorgResult,
  type SimulatedChainOptions,
} from "./chain";
export type { SimAccountRecord } from "./accounts";
export type { SimEscrowRecord, ValidationStatus } from "./escrow";
export type { SimSession } from "./smartSessions";
export type { SimStreamRecord } from "./streams";
export type { SimTopUpRule } from "./topup";
export type { SimVaultRecord } from "./vaults";
export { SIMULATED_CONTRACTS } from "../constants";
