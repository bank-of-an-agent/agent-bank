/**
 * `@agentbank/chain`: the chain boundary of Agent Bank.
 *
 * - {@link ChainGateway} and its JSON-safe types (`types.ts`);
 * - `EvmChainGateway` for Base Sepolia and Anvil (`evm/gateway.ts`);
 * - pure builders for account calls, sessions, the policy hook, the x402 spend key and account
 *   setup (`calls.ts`, `sessions.ts`, `spendKey.ts`, `setup.ts`);
 * - the decoder verifiers use (`decode.ts`) and the signing helpers (`signing.ts`);
 * - contract ABIs and addresses (`abis`, `constants.ts`).
 *
 * The in-memory simulator lives in `@agentbank/chain/simulated`.
 */
export * from "./types";
export * from "./abis";
export * from "./constants";
export * from "./account";
export * from "./sessions";
export * from "./calls";
export * from "./decode";
export * from "./signing";
export * from "./spendKey";
export * from "./setup";
export * from "./logs";
export * from "./erc7579";
export {
  parseUint,
  toJsonValue,
  userOperationFromJson,
  userOperationToJson,
  type UserOperationV07,
} from "./json";
export { checkPreparedOperation, decodePreparedOperation, hashUserOperation, signerForNonce } from "./userop";
export * from "./evm/gateway";
