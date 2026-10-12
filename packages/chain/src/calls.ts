import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  agentEscrowAbi,
  erc20Abi,
  MODULE_TYPE,
  paymentStreamsAbi,
  safe7579Abi,
  smartSessionsAbi,
  timeLockVaultsAbi,
  topUpExecutorAbi,
  topUpRuleInitParams,
} from "./abis";
import {
  buildSmartSession,
  encodePolicyHookConfig,
  type PolicyHookConfig,
  type SessionGrant,
} from "./sessions";
import type { Call, ChainContracts } from "./types";

/**
 * Builders for the calls a smart account executes. They are pure: the same inputs give the same
 * calldata on every gateway. Batch them into one operation (e.g. a payment plus its fee transfer)
 * with `prepareOperation({ calls: [...] })`.
 */

function required(address: Address | undefined, name: string): Address {
  if (!address) throw new Error(`${name} is not deployed on this chain`);
  return address;
}

// ------------------------------------------------------------------------------------------- ERC-20

/** `token.transfer(to, amount)`. */
export function transferCall(input: { token: Address; to: Address; amount: bigint }): Call {
  return {
    to: getAddress(input.token),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [input.to, input.amount] }),
  };
}

/** `token.approve(spender, amount)`. */
export function approveCall(input: { token: Address; spender: Address; amount: bigint }): Call {
  return {
    to: getAddress(input.token),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [input.spender, input.amount] }),
  };
}

/** `token.transferFrom(from, to, amount)` (e.g. sweeping a spend-key float back with its permit allowance). */
export function transferFromCall(input: {
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
}): Call {
  return {
    to: getAddress(input.token),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [input.from, input.to, input.amount],
    }),
  };
}

// ------------------------------------------------------------------------------------------- escrow

/** Parameters of {@link escrowLockCalls} (mirrors `AgentEscrow.lock`). */
export interface EscrowLockInput {
  escrow: Address;
  token: Address;
  payee: Address;
  amount: bigint;
  /** Unix seconds after which anyone may refund (in `(now, now + 365 days]`). */
  expiresAt: bigint;
  arbiter?: Address;
  /** ERC-8004 validator (requires `validationRequestHash` and `validationThreshold`). */
  validator?: Address;
  validationRequestHash?: Hex;
  validationThreshold?: number;
  /** Commitment to the off-chain terms (e.g. canonical hash of the escrow id and conditions). */
  termsHash: Hex;
}

/** `[token.approve(escrow, amount), escrow.lock(...)]`. */
export function escrowLockCalls(input: EscrowLockInput): Call[] {
  const escrow = getAddress(input.escrow);
  return [
    approveCall({ token: input.token, spender: escrow, amount: input.amount }),
    {
      to: escrow,
      data: encodeFunctionData({
        abi: agentEscrowAbi,
        functionName: "lock",
        args: [
          input.token,
          input.payee,
          input.amount,
          input.expiresAt,
          input.arbiter ?? zeroAddress,
          input.validator ?? zeroAddress,
          input.validationRequestHash ?? zeroHash,
          input.validationThreshold ?? 0,
          input.termsHash,
        ],
      }),
    },
  ];
}

/** `escrow.release(id)` (payer or arbiter). */
export function escrowReleaseCall(input: { escrow: Address; escrowId: bigint }): Call {
  return {
    to: getAddress(input.escrow),
    data: encodeFunctionData({ abi: agentEscrowAbi, functionName: "release", args: [input.escrowId] }),
  };
}

/** `escrow.releaseByValidation(id)` (anyone, once the ERC-8004 validator approved). */
export function escrowReleaseByValidationCall(input: { escrow: Address; escrowId: bigint }): Call {
  return {
    to: getAddress(input.escrow),
    data: encodeFunctionData({
      abi: agentEscrowAbi,
      functionName: "releaseByValidation",
      args: [input.escrowId],
    }),
  };
}

/** `escrow.refund(id)` (payee anytime; anyone after expiry or dispute timeout). */
export function escrowRefundCall(input: { escrow: Address; escrowId: bigint }): Call {
  return {
    to: getAddress(input.escrow),
    data: encodeFunctionData({ abi: agentEscrowAbi, functionName: "refund", args: [input.escrowId] }),
  };
}

/** `escrow.dispute(id)` (payer or payee, before expiry, arbiter required). */
export function escrowDisputeCall(input: { escrow: Address; escrowId: bigint }): Call {
  return {
    to: getAddress(input.escrow),
    data: encodeFunctionData({ abi: agentEscrowAbi, functionName: "dispute", args: [input.escrowId] }),
  };
}

/** `escrow.resolve(id, payeeAmount)` (arbiter only). */
export function escrowResolveCall(input: { escrow: Address; escrowId: bigint; payeeAmount: bigint }): Call {
  return {
    to: getAddress(input.escrow),
    data: encodeFunctionData({
      abi: agentEscrowAbi,
      functionName: "resolve",
      args: [input.escrowId, input.payeeAmount],
    }),
  };
}

// ------------------------------------------------------------------------------------------- streams

/** Parameters of {@link streamCreateCalls} (mirrors `PaymentStreams.createStream`). */
export interface StreamCreateInput {
  streams: Address;
  token: Address;
  payee: Address;
  deposit: bigint;
  amountPerInterval: bigint;
  /** Seconds per interval (1 = per-second streaming). */
  interval: bigint;
  /** Unix seconds; 0 (default) = now. */
  start?: bigint;
  /** Unix seconds; 0 (default) = open-ended. */
  stop?: bigint;
}

/** `[token.approve(streams, deposit), streams.createStream(...)]`. */
export function streamCreateCalls(input: StreamCreateInput): Call[] {
  const streams = getAddress(input.streams);
  return [
    approveCall({ token: input.token, spender: streams, amount: input.deposit }),
    {
      to: streams,
      data: encodeFunctionData({
        abi: paymentStreamsAbi,
        functionName: "createStream",
        args: [
          input.token,
          input.payee,
          input.deposit,
          input.amountPerInterval,
          input.interval,
          input.start ?? 0n,
          input.stop ?? 0n,
        ],
      }),
    },
  ];
}

/** `[token.approve(streams, amount), streams.topUp(id, amount)]` (payer only). */
export function streamTopUpCalls(input: {
  streams: Address;
  token: Address;
  streamId: bigint;
  amount: bigint;
}): Call[] {
  const streams = getAddress(input.streams);
  return [
    approveCall({ token: input.token, spender: streams, amount: input.amount }),
    {
      to: streams,
      data: encodeFunctionData({
        abi: paymentStreamsAbi,
        functionName: "topUp",
        args: [input.streamId, input.amount],
      }),
    },
  ];
}

/** `streams.settle(id)` (anyone; keepers call it hourly). */
export function streamSettleCall(input: { streams: Address; streamId: bigint }): Call {
  return {
    to: getAddress(input.streams),
    data: encodeFunctionData({ abi: paymentStreamsAbi, functionName: "settle", args: [input.streamId] }),
  };
}

/** `streams.cancel(id)` (payer or payee). */
export function streamCancelCall(input: { streams: Address; streamId: bigint }): Call {
  return {
    to: getAddress(input.streams),
    data: encodeFunctionData({ abi: paymentStreamsAbi, functionName: "cancel", args: [input.streamId] }),
  };
}

// ------------------------------------------------------------------------------------------- vaults

/** `vaults.createVault(token, unlockAt, owner)`; the caller (the account) becomes the vault's parent. */
export function vaultCreateCall(input: {
  vaults: Address;
  token: Address;
  unlockAt: bigint;
  owner: Address;
}): Call {
  return {
    to: getAddress(input.vaults),
    data: encodeFunctionData({
      abi: timeLockVaultsAbi,
      functionName: "createVault",
      args: [input.token, input.unlockAt, input.owner],
    }),
  };
}

/** `[token.approve(vaults, amount), vaults.deposit(id, amount)]`. */
export function vaultDepositCalls(input: {
  vaults: Address;
  token: Address;
  vaultId: bigint;
  amount: bigint;
}): Call[] {
  const vaults = getAddress(input.vaults);
  return [
    approveCall({ token: input.token, spender: vaults, amount: input.amount }),
    {
      to: vaults,
      data: encodeFunctionData({
        abi: timeLockVaultsAbi,
        functionName: "deposit",
        args: [input.vaultId, input.amount],
      }),
    },
  ];
}

/** `vaults.withdraw(id, amount)` (anyone, after `unlockAt`; funds go to the parent account). */
export function vaultWithdrawCall(input: { vaults: Address; vaultId: bigint; amount: bigint }): Call {
  return {
    to: getAddress(input.vaults),
    data: encodeFunctionData({
      abi: timeLockVaultsAbi,
      functionName: "withdraw",
      args: [input.vaultId, input.amount],
    }),
  };
}

/** `vaults.withdrawWithSignature(...)`: early withdrawal authorised by the vault owner's EIP-712 signature. */
export function vaultWithdrawWithSignatureCall(input: {
  vaults: Address;
  vaultId: bigint;
  amount: bigint;
  deadline: bigint;
  signature: Hex;
}): Call {
  return {
    to: getAddress(input.vaults),
    data: encodeFunctionData({
      abi: timeLockVaultsAbi,
      functionName: "withdrawWithSignature",
      args: [input.vaultId, input.amount, input.deadline, input.signature],
    }),
  };
}

// ------------------------------------------------------------------------------- sessions and modules

/** `smartSessions.enableSessions([session])` for a grant (owner operation). */
export function sessionInstallCalls(input: { contracts: ChainContracts; grant: SessionGrant }): Call[] {
  return [
    {
      to: input.contracts.smartSessions,
      data: encodeFunctionData({
        abi: smartSessionsAbi,
        functionName: "enableSessions",
        args: [[buildSmartSession(input.grant, input.contracts)]],
      }),
    },
  ];
}

/** `smartSessions.removeSession(permissionId)`: on-chain revocation (owner operation). */
export function sessionRevokeCall(input: { contracts: ChainContracts; permissionId: Hex }): Call {
  return {
    to: input.contracts.smartSessions,
    data: encodeFunctionData({
      abi: smartSessionsAbi,
      functionName: "removeSession",
      args: [input.permissionId],
    }),
  };
}

/**
 * `account.setRegistry(address(0), [], 0)`: stop ERC-7484 registry checks for module installs and
 * executor calls. Required before installing Agent Bank's (unattested) hook and executors on accounts
 * created through the Safe7579 launchpad. Owner operation.
 */
export function disableModuleRegistryCall(input: { account: Address }): Call {
  return {
    to: getAddress(input.account),
    data: encodeFunctionData({ abi: safe7579Abi, functionName: "setRegistry", args: [zeroAddress, [], 0] }),
  };
}

/** Safe7579 hook install/uninstall data: `abi.encode(HookType.GLOBAL, bytes4(0), data)`. */
function globalHookData(data: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
    [0, "0x00000000", data],
  );
}

/**
 * Install `AgentPolicyHook` as the account's global hook with `config` (owner operation). Set
 * `replace` when a hook is already installed: the hook's configuration can only change through
 * reinstalling it (or the owner's native Safe path), which also restarts its UTC-day window.
 */
export function policyHookInstallCalls(input: {
  account: Address;
  contracts: ChainContracts;
  config: PolicyHookConfig;
  replace?: boolean;
}): Call[] {
  const hook = required(input.contracts.policyHook, "AgentPolicyHook");
  const account = getAddress(input.account);
  const calls: Call[] = [];
  if (input.replace) {
    calls.push({
      to: account,
      data: encodeFunctionData({
        abi: safe7579Abi,
        functionName: "uninstallModule",
        args: [MODULE_TYPE.hook, hook, globalHookData("0x")],
      }),
    });
  }
  calls.push({
    to: account,
    data: encodeFunctionData({
      abi: safe7579Abi,
      functionName: "installModule",
      args: [MODULE_TYPE.hook, hook, globalHookData(encodePolicyHookConfig(input.config))],
    }),
  });
  return calls;
}

/** A treasury top-up rule (`ITopUpExecutor.TopUpRule`). */
export interface TopUpRuleInput {
  agent: Address;
  token: Address;
  refillTo: bigint;
  whenBelow: bigint;
  maxPerDay: bigint;
}

/** Install `TopUpExecutor` on a treasury account with its refill rules (owner operation). */
export function topUpExecutorInstallCalls(input: {
  account: Address;
  contracts: ChainContracts;
  rules: readonly TopUpRuleInput[];
}): Call[] {
  const executor = required(input.contracts.topUpExecutor, "TopUpExecutor");
  const initData =
    input.rules.length === 0
      ? "0x"
      : encodeAbiParameters(topUpRuleInitParams, [
          input.rules.map((r) => ({
            agent: r.agent,
            rule: { token: r.token, refillTo: r.refillTo, whenBelow: r.whenBelow, maxPerDay: r.maxPerDay },
          })),
        ]);
  return [
    {
      to: getAddress(input.account),
      data: encodeFunctionData({
        abi: safe7579Abi,
        functionName: "installModule",
        args: [MODULE_TYPE.executor, executor, initData],
      }),
    },
  ];
}

/** `topUpExecutor.topUp(treasury, agent)`: the keeper trigger (relay with `relayCall`). */
export function topUpCall(input: { executor: Address; treasury: Address; agent: Address }): Call {
  return {
    to: getAddress(input.executor),
    data: encodeFunctionData({
      abi: topUpExecutorAbi,
      functionName: "topUp",
      args: [input.treasury, input.agent],
    }),
  };
}
