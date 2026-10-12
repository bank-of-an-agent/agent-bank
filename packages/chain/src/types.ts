import type { Address, Hex, LocalAccount } from "viem";

/**
 * Types shared by every {@link ChainGateway} implementation.
 *
 * Conventions:
 * - Everything that crosses a process boundary (prepared operations, decoded calls, log
 *   arguments) is JSON-safe: integers that can exceed 2^53 are base-10 strings.
 * - Amounts handled in code are `bigint` minor units; there are no floats anywhere.
 * - Addresses are EIP-55 checksummed.
 */

/** A JSON value (what `JSON.parse` can return). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Block selector: an explicit block number or a finality tag. */
export type BlockTag = bigint | "latest" | "safe" | "finalized";

/** One call executed by a smart account (ERC-7579 execution). */
export interface Call {
  to: Address;
  /** Native value in wei; defaults to 0. Agent Bank never sends native value. */
  value?: bigint;
  data: Hex;
}

/** Every kind of call the decoder recognises. Anything else is `unknown`. */
export const CALL_KINDS = [
  "erc20_transfer",
  "erc20_transfer_from",
  "erc20_approve",
  "erc20_permit",
  "escrow_lock",
  "escrow_release",
  "escrow_refund",
  "escrow_dispute",
  "escrow_resolve",
  "stream_create",
  "stream_cancel",
  "stream_settle",
  "stream_topup",
  "vault_create",
  "vault_deposit",
  "vault_withdraw",
  "session_install",
  "session_revoke",
  "module_config",
  "unknown",
] as const;

/** What a decoded call does. */
export type CallKind = (typeof CALL_KINDS)[number];

/**
 * A call decoded from raw user-operation calldata. Produced by {@link ChainGateway.decodeOperation}
 * from the bytes that will actually execute, so verifiers (the co-signer) never trust a caller's
 * description of an operation.
 */
export interface DecodedCall {
  /** Call target. */
  to: Address;
  /** Native value in wei, base-10 string. */
  value: string;
  /** Raw calldata. */
  data: Hex;
  kind: CallKind;
  /** ERC-20 token moved or approved (for escrow/stream creation: the escrowed token). */
  token?: Address;
  /** Who receives funds: transfer recipient, escrow payee or stream payee. */
  recipient?: Address;
  /** Amount in token minor units, base-10 string (transfer amount, approval, escrow amount, stream deposit). */
  amount?: string;
  /** ERC-20 spender of an approval. */
  spender?: Address;
  /** Kind-specific decoded arguments (JSON-safe). */
  args?: Record<string, JsonValue>;
}

/**
 * An ERC-4337 v0.7 user operation in JSON-safe form (unpacked fields as in the bundler RPC,
 * integers as base-10 strings, absent optional fields as `null`).
 */
export interface UserOperationJson {
  sender: Address;
  nonce: string;
  factory: Address | null;
  factoryData: Hex | null;
  callData: Hex;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster: Address | null;
  paymasterVerificationGasLimit: string | null;
  paymasterPostOpGasLimit: string | null;
  paymasterData: Hex | null;
  signature: Hex;
}

/**
 * Who must authorize an operation:
 * - `session`: the agent's session key and the Agent Bank co-signer, both EIP-191 over the hash,
 *   with every call inside the session's on-chain scope (Smart Sessions, USE mode).
 * - `owner`: the principal's owner key alone (EIP-191 over the hash, OwnableValidator).
 */
export type OperationSigner = "session" | "owner";

/** A user operation ready to be signed. JSON-safe: store it, send it, hash it. */
export interface PreparedOperation {
  chainId: number;
  /** EntryPoint v0.7 the operation is bound to (part of the hash). */
  entryPoint: Address;
  /** The smart account (user operation sender). */
  account: Address;
  /** Which key(s) must sign. Derived from the nonce key; see {@link OperationSigner}. */
  signer: OperationSigner;
  /** Smart Sessions permission id for `session` operations, `null` for `owner` operations. */
  permissionId: Hex | null;
  /** The user operation with a placeholder signature (`0x`). */
  userOp: UserOperationJson;
  /** ERC-4337 v0.7 user operation hash. Signers sign this with EIP-191 (`signOperationHash`). */
  userOpHash: Hex;
  /** What the operation does, decoded from `userOp.callData` when it was prepared. */
  calls: DecodedCall[];
  /**
   * Unix seconds after which gateways refuse to submit the operation (the signing deadline).
   * It is not part of the user operation hash; on-chain the session's own expiry still applies.
   */
  validUntil: number;
}

/** Reference to an installed session (Smart Sessions permission id). */
export interface SessionRef {
  permissionId: Hex;
}

/** Inputs that determine an account's counterfactual address. */
export interface AccountDeployment {
  /** Owner key address (Safe owner and owner validator). */
  owner: Address;
  /** Agent Bank co-signer address configured on the account. */
  cosigner: Address;
  /** Distinguishes several accounts of the same owner (e.g. one per agent). */
  salt: bigint;
}

/** Input for the session path (`session` + co-signer signatures). */
export interface PrepareOperationInput {
  account: Address;
  /** The session that will sign. */
  session: SessionRef;
  calls: Call[];
  /** Signing deadline, unix seconds. Default: now + 10 minutes. */
  validUntil?: number;
}

/** Input for the owner path. */
export interface PrepareOwnerOperationInput {
  account: Address;
  calls: Call[];
  /**
   * Required while the account is not deployed: the operation then deploys it first. Must
   * predict to `account`.
   */
  deployment?: AccountDeployment;
  /** Signing deadline, unix seconds. Default: now + 15 minutes. */
  validUntil?: number;
}

/** Submit a prepared operation with its final, encoded `userOp.signature`. */
export interface SubmitOperationInput {
  op: PreparedOperation;
  /** `encodeOwnerSignature(...)` or `encodeSessionSignature(...)`. */
  signature: Hex;
}

/**
 * - `pending`: accepted (mempool / bundler), not yet in a block.
 * - `succeeded` / `reverted`: included; `reverted` means validation passed but execution failed
 *   (the nonce is used and no call took effect).
 * - `not_found`: unknown, dropped, or orphaned by a reorg and not re-included.
 */
export type OperationStatus = "pending" | "succeeded" | "reverted" | "not_found";

/** Where an operation stands; `logs` are its execution-phase logs, as bundlers report them. */
export interface OperationReceipt {
  userOpHash: Hex;
  status: OperationStatus;
  txHash: Hex | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  /** Revert data or reason for `reverted` operations. */
  revertReason: string | null;
  /** Gas paid by the account or its paymaster, in wei. */
  actualGasCost: bigint | null;
  /** Logs emitted by this operation's execution (normalized, see {@link ChainLog}). */
  logs: ChainLog[];
}

/** A block header reference. */
export interface BlockRef {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  /** Unix seconds. */
  timestamp: number;
}

/** Event names {@link ChainGateway.getLogs} understands. */
export const CHAIN_EVENT_NAMES = [
  // USDC (ERC-20, EIP-3009)
  "Transfer",
  "Approval",
  "AuthorizationUsed",
  "AuthorizationCanceled",
  // AgentEscrow
  "Locked",
  "ValidationConfigured",
  "Released",
  "Refunded",
  "Disputed",
  "Resolved",
  // PaymentStreams
  "StreamCreated",
  "StreamToppedUp",
  "StreamSettled",
  "StreamCanceled",
  "StreamSettlementDeferred",
  // TimeLockVaults
  "VaultCreated",
  "Deposited",
  "Withdrawn",
  "OwnerChanged",
  // TopUpExecutor
  "ToppedUp",
  // AgentPolicyHook
  "SpendRecorded",
  // Smart Sessions
  "SessionCreated",
  "SessionRemoved",
  // EntryPoint v0.7
  "UserOperationEvent",
  "UserOperationRevertReason",
  "AccountDeployed",
] as const;

/** One of {@link CHAIN_EVENT_NAMES}. */
export type ChainEventName = (typeof CHAIN_EVENT_NAMES)[number];

/**
 * A normalized log. Every argument is a string (the shape of `ChainEventInternal.args` in
 * `@agentbank/core`): integers as base-10 strings, addresses checksummed, bytes as lowercase hex,
 * booleans as `"true"` / `"false"`. The identity of a log is `(blockHash, txHash, logIndex)`; after a
 * reorg the same `(txHash, logIndex)` may reappear with another `blockHash`. Block timestamps come
 * from {@link ChainGateway.getBlock}.
 */
export interface ChainLog {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  address: Address;
  eventName: ChainEventName;
  args: Record<string, string>;
}

/** Log filter. Both bounds are inclusive. */
export interface LogQuery {
  fromBlock: bigint;
  toBlock: bigint;
  /** Emitting contracts. Default: every contract the gateway knows (USDC, escrow, streams, vaults, ...). */
  addresses?: Address[];
  /** Events to return. Default: all of {@link CHAIN_EVENT_NAMES}. */
  events?: ChainEventName[];
  /**
   * Keep only logs with at least one address-typed argument (indexed or not) equal to one of these,
   * e.g. USDC `Transfer` logs from or to known accounts.
   */
  involving?: Address[];
}

/** EIP-3009 `transferWithAuthorization` relayed by the x402 facilitator. */
export interface SettleAuthorizationInput {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  /** Unix seconds; the authorization is valid strictly after this. */
  validAfter: bigint;
  /** Unix seconds; the authorization is valid strictly before this. */
  validBefore: bigint;
  /** 32-byte authorization nonce. */
  nonce: Hex;
  /** 65-byte ECDSA signature (v,r,s overload) or a longer ERC-1271 signature (bytes overload). */
  signature: Hex;
  /**
   * The relayer that pays gas. Required by the EVM gateway unless one was configured; the
   * simulator only records its address. Testnet keys only, from the secret manager.
   */
  relayer?: LocalAccount;
}

/**
 * A permissionless contract call sent from an Agent Bank keeper/relayer wallet: stream `settle`,
 * `TopUpExecutor.topUp`, vault `withdraw` after unlock or with the owner's signature, escrow
 * `refund` after expiry. The keeper only pays gas; the contracts decide where funds go. Gateways
 * accept only calls to the Agent Bank contracts in {@link ChainContracts}, with no native value.
 */
export interface RelayCallInput {
  call: Call;
  /** The keeper that pays gas (EVM gateway: required unless configured; simulator: optional). */
  relayer?: LocalAccount;
}

/** Contract addresses a gateway targets. */
export interface ChainContracts {
  /** EntryPoint v0.7. */
  entryPoint: Address;
  /** Settlement asset (USDC on Base Sepolia, MockUSDC on Anvil, simulated USDC in memory). */
  usdc: Address;
  /** Safe v1.4.1 singleton (SafeL2 on Base). */
  safeSingleton: Address;
  safeProxyFactory: Address;
  /** Safe7579 adapter (ERC-7579 module manager and fallback handler). */
  safe7579: Address;
  safe7579Launchpad: Address;
  /** Rhinestone Smart Sessions validator. */
  smartSessions: Address;
  /** Rhinestone OwnableValidator: owner validator and stateless 2-of-2 session validator. */
  ownableValidator: Address;
  /** ERC-7484 attesters trusted for module installs (Safe7579 registry config). */
  attesters: Address[];
  attestersThreshold: number;
  /** Smart Sessions policies. */
  policies: {
    timeFrame: Address;
    spendingLimits: Address;
    universalAction: Address;
    sudo: Address;
  };
  /** Agent Bank contracts (absent until deployed on the chain). */
  escrow?: Address;
  streams?: Address;
  vaults?: Address;
  policyHook?: Address;
  topUpExecutor?: Address;
  sweepExecutor?: Address;
}

/** The chain boundary every service uses (see docs/architecture.md, "ChainGateway"). */
export interface ChainGateway {
  readonly chainId: number;
  readonly contracts: ChainContracts;

  /** Counterfactual (CREATE2) address of the Safe7579 account for these inputs. Pure: no deployment needed. */
  predictAccountAddress(input: AccountDeployment): Promise<Address>;
  isDeployed(address: Address): Promise<boolean>;
  getTokenBalance(token: Address, holder: Address, blockNumber?: bigint): Promise<bigint>;
  /** Whether a Smart Sessions permission is enabled on the account (installed and not removed). */
  isSessionEnabled(account: Address, permissionId: Hex): Promise<boolean>;

  /** Prepare a session-path operation (session key + co-signer). The account must be deployed. */
  prepareOperation(input: PrepareOperationInput): Promise<PreparedOperation>;
  /** Prepare an owner-path operation (owner key alone); deploys the account first when needed. */
  prepareOwnerOperation(input: PrepareOwnerOperationInput): Promise<PreparedOperation>;
  /** Decode the calls the operation executes from its raw calldata; never trusts `op.calls`. */
  decodeOperation(op: PreparedOperation): DecodedCall[];
  /** Recompute the user operation hash from the raw user operation; never trusts `op.userOpHash`. */
  hashOperation(op: PreparedOperation): Hex;
  submitOperation(input: SubmitOperationInput): Promise<{ userOpHash: Hex }>;
  getOperationReceipt(userOpHash: Hex): Promise<OperationReceipt>;

  getBlock(tag: BlockTag): Promise<BlockRef>;
  getLogs(input: LogQuery): Promise<ChainLog[]>;

  /** Relay an EIP-3009 `transferWithAuthorization` (x402 facilitator). */
  settleAuthorization(input: SettleAuthorizationInput): Promise<{ txHash: Hex }>;
  /** Send a permissionless keeper call (see {@link RelayCallInput}). */
  relayCall(input: RelayCallInput): Promise<{ txHash: Hex }>;
  /** EIP-3009 `authorizationState`: true once the nonce was used or canceled. */
  authorizationState(token: Address, authorizer: Address, nonce: Hex): Promise<boolean>;
  /**
   * Verify `signature` over the raw 32-byte `hash` for `address`: ECDSA for EOAs, ERC-1271 for
   * deployed contracts, ERC-6492 for counterfactual ones.
   */
  verifySignature(input: { address: Address; hash: Hex; signature: Hex }): Promise<boolean>;
}
