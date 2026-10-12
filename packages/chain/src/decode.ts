import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  size,
  slice,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  agentEscrowAbi,
  erc20Abi,
  ownableValidatorAbi,
  ownableValidatorConfigParams,
  paymentStreamsAbi,
  policyConfigParams,
  safe7579Abi,
  safeAbi,
  smartSessionsAbi,
  timeLockVaultsAbi,
  topUpExecutorAbi,
} from "./abis";
import { decodeExecute } from "./erc7579";
import { toJsonValue } from "./json";
import { permissionIdOf, type SmartSession } from "./sessions";
import type { ChainContracts, DecodedCall, JsonValue } from "./types";

/**
 * Decoding of account calldata into {@link DecodedCall}s. Classification is by target *and*
 * selector: Agent Bank contract functions are only recognised at the chain's configured addresses,
 * ERC-20 calls on any target (verifiers must still check `token`). Anything else, and any calldata
 * that does not decode cleanly, is `unknown`, which verifiers must reject.
 *
 * `module_config` covers account administration, which only owner operations may contain: module
 * install/uninstall and `setRegistry` (self-calls, `args.function`), TopUpExecutor rules, and owner
 * key management (`args.module` `"Safe"`: `swapOwner` self-call; `"OwnableValidator"`: `addOwner`,
 * `removeOwner`, `setThreshold`).
 */

export interface DecodeContext {
  contracts: ChainContracts;
  /** The executing account; calls to it are module management (`module_config`). */
  account?: Address;
}

type AnyDecoded = { functionName: string; args: readonly unknown[] };

function tryDecode(abi: Abi, data: Hex): AnyDecoded | null {
  try {
    const decoded = decodeFunctionData({ abi, data }) as AnyDecoded;
    return { functionName: decoded.functionName, args: decoded.args ?? [] };
  } catch {
    return null;
  }
}

function same(a: Address | undefined, b: Address): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function str(value: unknown): string {
  return (value as bigint).toString();
}

/** Decode one call. */
export function decodeCall(
  call: { to: Address; value?: bigint; data: Hex },
  ctx: DecodeContext,
): DecodedCall {
  const to = getAddress(call.to);
  const base: DecodedCall = { to, value: (call.value ?? 0n).toString(), data: call.data, kind: "unknown" };
  if (size(call.data) < 4) return base;
  const { contracts } = ctx;

  // ERC-20 on any target.
  const erc20 = tryDecode(erc20Abi, call.data);
  if (erc20) {
    const a = erc20.args;
    switch (erc20.functionName) {
      case "transfer":
        return {
          ...base,
          kind: "erc20_transfer",
          token: to,
          recipient: getAddress(a[0] as Address),
          amount: str(a[1]),
        };
      case "approve":
        return {
          ...base,
          kind: "erc20_approve",
          token: to,
          spender: getAddress(a[0] as Address),
          amount: str(a[1]),
        };
      case "transferFrom":
        return {
          ...base,
          kind: "erc20_transfer_from",
          token: to,
          recipient: getAddress(a[1] as Address),
          amount: str(a[2]),
          args: { from: getAddress(a[0] as Address) },
        };
      case "permit":
        // Owner operations only (spend-key provisioning); sessions can never call it.
        return {
          ...base,
          kind: "erc20_permit",
          token: to,
          spender: getAddress(a[1] as Address),
          amount: str(a[2]),
          args: { owner: getAddress(a[0] as Address), deadline: str(a[3]) },
        };
      default:
        break; // other token functions (transferWithAuthorization, ...) stay unknown
    }
  }

  if (same(contracts.escrow, to)) {
    const d = tryDecode(agentEscrowAbi, call.data);
    if (d) return decodeEscrow(base, d);
  }
  if (same(contracts.streams, to)) {
    const d = tryDecode(paymentStreamsAbi, call.data);
    if (d) return decodeStreams(base, d);
  }
  if (same(contracts.vaults, to)) {
    const d = tryDecode(timeLockVaultsAbi, call.data);
    if (d) return decodeVaults(base, d);
  }
  if (same(contracts.smartSessions, to)) {
    const d = tryDecode(smartSessionsAbi, call.data);
    if (d?.functionName === "enableSessions") {
      const sessions = d.args[0] as readonly SmartSession[];
      return {
        ...base,
        kind: "session_install",
        args: {
          permissionIds: sessions.map((s) => permissionIdOf(s)),
          sessions: sessions.map((s) => describeSession(s, contracts)),
        },
      };
    }
    if (d?.functionName === "removeSession") {
      return { ...base, kind: "session_revoke", args: { permissionId: d.args[0] as Hex } };
    }
  }
  if (ctx.account && same(ctx.account, to)) {
    const d = tryDecode(safe7579Abi, call.data);
    if (d && ["installModule", "uninstallModule", "setRegistry"].includes(d.functionName)) {
      return { ...base, kind: "module_config", args: describeModuleCall(d, contracts) };
    }
    const owner = tryDecode(safeAbi, call.data);
    if (owner?.functionName === "swapOwner") {
      return {
        ...base,
        kind: "module_config",
        args: {
          module: "Safe",
          function: "swapOwner",
          prevOwner: getAddress(owner.args[0] as Address),
          oldOwner: getAddress(owner.args[1] as Address),
          newOwner: getAddress(owner.args[2] as Address),
        },
      };
    }
  }
  if (same(contracts.ownableValidator, to)) {
    const d = tryDecode(ownableValidatorAbi, call.data);
    if (d?.functionName === "addOwner") {
      return {
        ...base,
        kind: "module_config",
        args: { module: "OwnableValidator", function: "addOwner", owner: getAddress(d.args[0] as Address) },
      };
    }
    if (d?.functionName === "removeOwner") {
      return {
        ...base,
        kind: "module_config",
        args: {
          module: "OwnableValidator",
          function: "removeOwner",
          prevOwner: getAddress(d.args[0] as Address),
          owner: getAddress(d.args[1] as Address),
        },
      };
    }
    if (d?.functionName === "setThreshold") {
      return {
        ...base,
        kind: "module_config",
        args: { module: "OwnableValidator", function: "setThreshold", threshold: str(d.args[0]) },
      };
    }
  }
  if (same(contracts.topUpExecutor, to)) {
    const d = tryDecode(topUpExecutorAbi, call.data);
    if (d && (d.functionName === "setRule" || d.functionName === "removeRule")) {
      return {
        ...base,
        kind: "module_config",
        args: { module: "TopUpExecutor", function: d.functionName, params: toJsonValue(d.args) },
      };
    }
  }
  return base;
}

function decodeEscrow(base: DecodedCall, d: AnyDecoded): DecodedCall {
  const a = d.args;
  switch (d.functionName) {
    case "lock":
      return {
        ...base,
        kind: "escrow_lock",
        token: getAddress(a[0] as Address),
        recipient: getAddress(a[1] as Address),
        amount: str(a[2]),
        args: {
          expiresAt: str(a[3]),
          arbiter: getAddress(a[4] as Address),
          validator: getAddress(a[5] as Address),
          validationRequestHash: a[6] as Hex,
          validationThreshold: Number(a[7]),
          termsHash: a[8] as Hex,
        },
      };
    case "release":
      return { ...base, kind: "escrow_release", args: { escrowId: str(a[0]), byValidation: false } };
    case "releaseByValidation":
      return { ...base, kind: "escrow_release", args: { escrowId: str(a[0]), byValidation: true } };
    case "refund":
      return { ...base, kind: "escrow_refund", args: { escrowId: str(a[0]) } };
    case "dispute":
      return { ...base, kind: "escrow_dispute", args: { escrowId: str(a[0]) } };
    case "resolve":
      return {
        ...base,
        kind: "escrow_resolve",
        amount: str(a[1]),
        args: { escrowId: str(a[0]), payeeAmount: str(a[1]) },
      };
    default:
      return base;
  }
}

function decodeStreams(base: DecodedCall, d: AnyDecoded): DecodedCall {
  const a = d.args;
  switch (d.functionName) {
    case "createStream":
      return {
        ...base,
        kind: "stream_create",
        token: getAddress(a[0] as Address),
        recipient: getAddress(a[1] as Address),
        amount: str(a[2]),
        args: { amountPerInterval: str(a[3]), interval: str(a[4]), start: str(a[5]), stop: str(a[6]) },
      };
    case "topUp":
      return { ...base, kind: "stream_topup", amount: str(a[1]), args: { streamId: str(a[0]) } };
    case "settle":
      return { ...base, kind: "stream_settle", args: { streamId: str(a[0]) } };
    case "cancel":
      return { ...base, kind: "stream_cancel", args: { streamId: str(a[0]) } };
    default:
      return base;
  }
}

function decodeVaults(base: DecodedCall, d: AnyDecoded): DecodedCall {
  const a = d.args;
  switch (d.functionName) {
    case "createVault":
      return {
        ...base,
        kind: "vault_create",
        token: getAddress(a[0] as Address),
        args: { unlockAt: str(a[1]), owner: getAddress(a[2] as Address) },
      };
    case "deposit":
      return { ...base, kind: "vault_deposit", amount: str(a[1]), args: { vaultId: str(a[0]) } };
    case "withdraw":
      return {
        ...base,
        kind: "vault_withdraw",
        amount: str(a[1]),
        args: { vaultId: str(a[0]), early: false },
      };
    case "withdrawWithSignature":
      return {
        ...base,
        kind: "vault_withdraw",
        amount: str(a[1]),
        args: { vaultId: str(a[0]), early: true, deadline: str(a[2]) },
      };
    default:
      return base;
  }
}

function moduleName(address: Address, contracts: ChainContracts): string {
  const known: [Address | undefined, string][] = [
    [contracts.policyHook, "AgentPolicyHook"],
    [contracts.topUpExecutor, "TopUpExecutor"],
    [contracts.sweepExecutor, "SweepExecutor"],
    [contracts.smartSessions, "SmartSessions"],
    [contracts.ownableValidator, "OwnableValidator"],
  ];
  return known.find(([a]) => same(a, address))?.[1] ?? "unknown";
}

function describeModuleCall(d: AnyDecoded, contracts: ChainContracts): Record<string, JsonValue> {
  if (d.functionName === "setRegistry") {
    return {
      function: "setRegistry",
      registry: getAddress(d.args[0] as Address),
      attesters: toJsonValue(d.args[1]),
      threshold: Number(d.args[2]),
    };
  }
  const moduleType = d.args[0] as bigint;
  const module = getAddress(d.args[1] as Address);
  const out: Record<string, JsonValue> = {
    function: d.functionName,
    moduleType: moduleType.toString(),
    module,
    name: moduleName(module, contracts),
    data: d.args[2] as Hex,
  };
  if (moduleType === 4n && same(contracts.policyHook, module) && d.functionName === "installModule") {
    try {
      const [, , inner] = decodeAbiParameters(
        [{ type: "uint8" }, { type: "bytes4" }, { type: "bytes" }],
        d.args[2] as Hex,
      );
      if (inner !== "0x") out.policy = toJsonValue(decodeAbiParameters(policyConfigParams, inner)[0]);
    } catch {
      out.policy = null;
    }
  }
  return out;
}

/** JSON summary of a Smart Sessions `Session` (for display and verification). */
export function describeSession(session: SmartSession, contracts: ChainContracts): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {
    permissionId: permissionIdOf(session),
    sessionValidator: getAddress(session.sessionValidator),
    salt: session.salt,
    permitERC4337Paymaster: session.permitERC4337Paymaster,
    erc1271:
      session.erc7739Policies.erc1271Policies.length > 0 ||
      session.erc7739Policies.allowedERC7739Content.length > 0,
    userOpPolicies: session.userOpPolicies.map((p) => getAddress(p.policy)),
    actions: session.actions.map((a) => ({
      target: getAddress(a.actionTarget),
      selector: a.actionTargetSelector,
      policies: a.actionPolicies.map((p) => getAddress(p.policy)),
    })),
  };
  if (same(contracts.ownableValidator, session.sessionValidator)) {
    try {
      const [threshold, owners] = decodeAbiParameters(
        ownableValidatorConfigParams,
        session.sessionValidatorInitData,
      );
      out.threshold = Number(threshold);
      out.signers = owners.map((o) => getAddress(o));
    } catch {
      out.signers = null;
    }
  }
  const timeFrame = session.userOpPolicies.find((p) => same(contracts.policies.timeFrame, p.policy));
  if (timeFrame && size(timeFrame.initData) >= 12) {
    out.validUntil = Number(BigInt(slice(timeFrame.initData, 0, 6)));
    out.validAfter = Number(BigInt(slice(timeFrame.initData, 6, 12)));
  }
  return out;
}

/**
 * Decode the calls a user operation's calldata executes (see `decodeExecute`). Calldata that is not
 * a plain default-mode execution decodes to a single `unknown` call on the account.
 */
export function decodeCalls(callData: Hex, ctx: DecodeContext & { account: Address }): DecodedCall[] {
  const execution = decodeExecute(callData);
  if (!execution.ok) {
    return [
      {
        to: getAddress(ctx.account),
        value: "0",
        data: callData,
        kind: "unknown",
        args: { reason: execution.reason },
      },
    ];
  }
  return execution.calls.map((c) => decodeCall(c, ctx));
}
