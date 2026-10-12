import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  size,
  slice,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  ownableValidatorConfigParams,
  smartSessionsAbi,
  spendingLimitsInitParams,
  universalActionInitParams,
} from "../abis";
import { CALLTYPE_BATCH, CALLTYPE_SINGLE, decodeExecutionMode, EXECTYPE_DEFAULT } from "../erc7579";
import { permissionIdOf, type SmartSession } from "../sessions";
import type { ChainContracts } from "../types";
import { ecrecover, ethSignedMessageHash, splitSignature } from "./ecdsa";
import { JMap } from "./journal";
import { emitLog, eventOf, key, revert, SimRevert, type ExecContext } from "./vm";
import type { World } from "./world";

const SESSION_CREATED = eventOf(smartSessionsAbi, "SessionCreated");
const SESSION_REMOVED = eventOf(smartSessionsAbi, "SessionRemoved");

const EXECUTE = toFunctionSelector("execute(bytes32,bytes)");
const EXECUTE_USER_OP = toFunctionSelector(
  "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)",
);
const VALUE_SELECTOR: Hex = "0xffffffff";
const FALLBACK_TARGET_FLAG: Address = "0x0000000000000000000000000000000000000001";
const FALLBACK_TARGET_SELECTOR_FLAG: Hex = "0x00000001";

const ERC20_TRANSFER = "0xa9059cbb";
const ERC20_TRANSFER_FROM = "0x23b872dd";
const ERC20_APPROVE = "0x095ea7b3";
const ERC20_INCREASE_ALLOWANCE = "0x39509351";

/** A policy attached to a session (state lives in {@link SimSmartSessions}'s policy store). */
interface PolicyRef {
  policy: Address;
  configKey: string;
}

/** An enabled session (one Smart Sessions permission of one account). */
export interface SimSession {
  permissionId: Hex;
  sessionValidator: Address;
  sessionValidatorData: Hex;
  userOpPolicies: PolicyRef[];
  /** actionId → policies. */
  actions: Record<string, PolicyRef[]>;
  /** (target, selector) of each enabled action, for inspection. */
  actionTargets: { target: Address; selector: Hex }[];
  permitERC4337Paymaster: boolean;
  erc1271: boolean;
}

type PolicyState =
  | { kind: "sudo" }
  | { kind: "timeFrame"; validUntil: number; validAfter: number }
  | {
      kind: "universalAction";
      valueLimitPerUse: bigint;
      rules: {
        condition: number;
        offset: bigint;
        isLimited: boolean;
        ref: Hex;
        limit: bigint;
        used: bigint;
      }[];
    }
  | { kind: "spendingLimits"; tokens: Record<string, { limit: bigint; spent: bigint; approved: bigint }> };

/** Validity window produced by policies (0 = unbounded). */
export interface Window {
  validAfter: number;
  validUntil: number;
}

/** Thrown when Smart Sessions would revert during validation (the bundler rejects the operation). */
export class SessionValidationError extends SimRevert {
  constructor(
    reason: string,
    readonly code: "session_revoked" | "policy_denied" | "invalid_request",
  ) {
    super(reason);
  }
}

function actionIdOf(target: Address, selector: Hex): string {
  return keccak256(encodePacked(["address", "bytes4"], [target, selector]));
}

/** Intersect validity windows (max validAfter, min non-zero validUntil). */
export function intersect(a: Window, b: Window): Window {
  const validUntil =
    a.validUntil === 0
      ? b.validUntil
      : b.validUntil === 0
        ? a.validUntil
        : Math.min(a.validUntil, b.validUntil);
  return { validAfter: Math.max(a.validAfter, b.validAfter), validUntil };
}

/**
 * `CheckNSignatures.recoverNSignatures` + OwnableValidator matching: recovers the first `threshold`
 * 65-byte signatures (v > 30: EIP-191 over `hash` with v - 4; else raw `hash`), sorts and
 * de-duplicates the signers, and counts those in `owners`. Contract signatures (v = 0) are not
 * simulated and count as invalid.
 */
export function checkSignatures(
  hash: Hex,
  signatures: Hex,
  owners: readonly Address[],
  threshold: number,
): boolean {
  if (threshold <= 0) return false;
  if (size(signatures) < threshold * 65) return false;
  const recovered = new Set<string>();
  for (let i = 0; i < threshold; i++) {
    const parts = splitSignature(slice(signatures, i * 65, i * 65 + 65));
    if (!parts || parts.v === 0) continue;
    const signer =
      parts.v > 30
        ? ecrecover(ethSignedMessageHash(hash), parts.v - 4, parts.r, parts.s)
        : ecrecover(hash, parts.v, parts.r, parts.s);
    if (signer) recovered.add(signer.toLowerCase());
  }
  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  let valid = 0;
  for (const s of recovered) if (ownerSet.has(s)) valid++;
  return valid >= threshold;
}

/** OwnableValidator `validateSignatureWithData` (stateless; session validator path). */
export function validateSignatureWithData(hash: Hex, signature: Hex, data: Hex): boolean {
  let threshold: bigint;
  let owners: readonly Address[];
  try {
    [threshold, owners] = decodeAbiParameters(ownableValidatorConfigParams, data);
  } catch {
    return false;
  }
  for (let i = 1; i < owners.length; i++) {
    if (BigInt(owners[i - 1] as Address) >= BigInt(owners[i] as Address)) return false; // sorted and unique
  }
  return checkSignatures(hash, signature, owners, Number(threshold));
}

/** Smart Sessions (USE mode) as deployed: session storage, policies, validation of session operations. */
export class SimSmartSessions {
  private readonly sessions: JMap<string, SimSession>;
  private readonly policyState: JMap<string, PolicyState>;

  constructor(
    world: World,
    readonly address: Address,
    private readonly contracts: ChainContracts,
  ) {
    this.sessions = new JMap(world.journal);
    this.policyState = new JMap(world.journal);
  }

  get(account: Address, permissionId: Hex): SimSession | undefined {
    return this.sessions.get(key(account, permissionId));
  }

  /** All enabled sessions of an account. */
  list(account: Address): SimSession[] {
    const prefix = `${account.toLowerCase()}:`;
    const out: SimSession[] = [];
    for (const [k, v] of this.sessions.entries()) if (k.startsWith(prefix)) out.push(v);
    return out;
  }

  /** Policy state for inspection (spent amounts, rule usage, windows). */
  policyStateOf(configKey: string): PolicyState | undefined {
    return this.policyState.get(configKey);
  }

  handle(ctx: ExecContext, from: Address, data: Hex): Hex {
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: smartSessionsAbi, data });
    } catch {
      revert("SmartSession: unsupported function");
    }
    if (decoded.functionName === "enableSessions") {
      const ids = this.enableSessions(ctx, from, decoded.args[0] as readonly SmartSession[]);
      return encodeAbiParameters([{ type: "bytes32[]" }], [ids]);
    }
    if (decoded.functionName === "removeSession") {
      this.removeSession(ctx, from, decoded.args[0] as Hex);
      return "0x";
    }
    return revert(`SmartSession: ${decoded.functionName} is a view; read it from the gateway`);
  }

  enableSessions(ctx: ExecContext, account: Address, sessions: readonly SmartSession[]): Hex[] {
    if (sessions.length === 0) revert("InvalidData()");
    const ids: Hex[] = [];
    for (const s of sessions) {
      const permissionId = permissionIdOf(s);
      const existing = this.get(account, permissionId);
      const userOpPolicies = [...(existing?.userOpPolicies ?? [])];
      const actions: Record<string, PolicyRef[]> = { ...(existing?.actions ?? {}) };
      const actionTargets = [...(existing?.actionTargets ?? [])];
      for (const p of s.userOpPolicies) {
        const ref = {
          policy: getAddress(p.policy),
          configKey: key(account, permissionId, "userop", p.policy),
        };
        this.initPolicy(account, ref, p.initData);
        if (!userOpPolicies.some((x) => x.policy === ref.policy)) userOpPolicies.push(ref);
      }
      for (const a of s.actions) {
        const target = getAddress(a.actionTarget);
        if (target === FALLBACK_TARGET_FLAG && a.actionTargetSelector !== FALLBACK_TARGET_SELECTOR_FLAG)
          revert("InvalidActionId()");
        if (a.actionPolicies.length === 0) revert("NoPoliciesSet()");
        const actionId = actionIdOf(target, a.actionTargetSelector);
        const list = [...(actions[actionId] ?? [])];
        for (const p of a.actionPolicies) {
          const ref = {
            policy: getAddress(p.policy),
            configKey: key(account, permissionId, actionId, p.policy),
          };
          this.initPolicy(account, ref, p.initData);
          if (!list.some((x) => x.policy === ref.policy)) list.push(ref);
        }
        actions[actionId] = list;
        if (!actionTargets.some((t) => t.target === target && t.selector === a.actionTargetSelector)) {
          actionTargets.push({ target, selector: a.actionTargetSelector });
        }
      }
      this.sessions.set(key(account, permissionId), {
        permissionId,
        sessionValidator: existing?.sessionValidator ?? getAddress(s.sessionValidator),
        sessionValidatorData: existing?.sessionValidatorData ?? s.sessionValidatorInitData,
        userOpPolicies,
        actions,
        actionTargets,
        permitERC4337Paymaster: s.permitERC4337Paymaster,
        erc1271:
          (existing?.erc1271 ?? false) ||
          s.erc7739Policies.erc1271Policies.length > 0 ||
          s.erc7739Policies.allowedERC7739Content.length > 0,
      });
      emitLog(ctx, this.address, SESSION_CREATED, { permissionId, account });
      ids.push(permissionId);
    }
    return ids;
  }

  removeSession(ctx: ExecContext, account: Address, permissionId: Hex): void {
    if (BigInt(permissionId) === 0n) revert("InvalidSession()");
    this.sessions.delete(key(account, permissionId));
    emitLog(ctx, this.address, SESSION_REMOVED, { permissionId, smartAccount: account });
  }

  private initPolicy(account: Address, ref: PolicyRef, initData: Hex): void {
    const p = this.contracts.policies;
    if (ref.policy === getAddress(p.sudo)) {
      this.policyState.set(ref.configKey, { kind: "sudo" });
    } else if (ref.policy === getAddress(p.timeFrame)) {
      if (size(initData) < 12) revert("TimeFramePolicy: init data too short");
      const validUntil = Number(BigInt(slice(initData, 0, 6)));
      const validAfter = Number(BigInt(slice(initData, 6, 12)));
      if (validUntil === 0 && validAfter === 0) revert("PolicyNotInitialized()");
      if (validUntil !== 0 && validAfter > validUntil) revert("InvalidTimeFrame()");
      this.policyState.set(ref.configKey, { kind: "timeFrame", validUntil, validAfter });
    } else if (ref.policy === getAddress(p.universalAction)) {
      const [config] = decodeAbiParameters(universalActionInitParams, initData);
      const length = Number(config.paramRules.length);
      if (length > 16) revert("UniActionPolicy: too many rules");
      this.policyState.set(ref.configKey, {
        kind: "universalAction",
        valueLimitPerUse: config.valueLimitPerUse,
        rules: config.paramRules.rules.slice(0, length).map((r) => ({
          condition: r.condition,
          offset: r.offset,
          isLimited: r.isLimited,
          ref: r.ref,
          limit: r.usage.limit,
          used: r.usage.used,
        })),
      });
    } else if (ref.policy === getAddress(p.spendingLimits)) {
      const [tokens, limits] = decodeAbiParameters(spendingLimitsInitParams, initData);
      if (tokens.length !== limits.length) revert("InvalidInitDataLength()");
      const state: Record<string, { limit: bigint; spent: bigint; approved: bigint }> = {};
      tokens.forEach((t, i) => {
        if (t === zeroAddress) revert("InvalidTokenAddress()");
        const limit = limits[i] as bigint;
        if (limit === 0n) revert("InvalidLimit()");
        state[t.toLowerCase()] = { limit, spent: 0n, approved: 0n };
      });
      this.policyState.set(ref.configKey, { kind: "spendingLimits", tokens: state });
    } else {
      revert(`simulator: policy ${ref.policy} is not supported`);
    }
    void account;
  }

  /** `IActionPolicy.checkAction`: returns the window or throws (policy violation / revert). */
  private checkActionPolicy(
    ref: PolicyRef,
    account: Address,
    target: Address,
    value: bigint,
    data: Hex,
  ): Window {
    const state = this.policyState.get(ref.configKey);
    if (!state) throw new SessionValidationError(`PolicyNotInitialized(${ref.policy})`, "policy_denied");
    const violation = (why: string) =>
      new SessionValidationError(`PolicyViolation(${ref.policy}): ${why}`, "policy_denied");
    switch (state.kind) {
      case "sudo":
        return { validAfter: 0, validUntil: 0 };
      case "timeFrame":
        return { validAfter: state.validAfter, validUntil: state.validUntil };
      case "universalAction": {
        if (state.rules.length === 0)
          throw new SessionValidationError("PolicyNotInitialized()", "policy_denied");
        if (value > state.valueLimitPerUse)
          throw new SessionValidationError("ValueLimitExceeded()", "policy_denied");
        const rules = state.rules.map((r) => ({ ...r }));
        for (const [i, rule] of rules.entries()) {
          const start = 4 + Number(rule.offset);
          if (size(data) < start + 32) throw violation("calldata too short");
          const param = BigInt(slice(data, start, start + 32));
          const ref32 = BigInt(rule.ref);
          let ok: boolean;
          switch (rule.condition) {
            case 0:
              ok = param === ref32;
              break;
            case 1:
              ok = param > ref32;
              break;
            case 2:
              ok = param < ref32;
              break;
            case 3:
              ok = param >= ref32;
              break;
            case 4:
              ok = param <= ref32;
              break;
            case 5:
              ok = param !== ref32;
              break;
            case 6:
              ok = param >= ref32 >> 128n && param <= (ref32 & (2n ** 128n - 1n));
              break;
            default:
              ok = false;
          }
          if (!ok) throw violation(`rule ${i} failed`);
          if (rule.isLimited) {
            if (rule.used + param > rule.limit) throw violation(`rule ${i} usage limit`);
            rule.used += param;
          }
        }
        this.policyState.set(ref.configKey, { ...state, rules });
        return { validAfter: 0, validUntil: 0 };
      }
      case "spendingLimits": {
        if (value !== 0n) throw violation("native value");
        if (size(data) < 4) throw violation("calldata too short");
        const selector = slice(data, 0, 4);
        let amount: bigint;
        let isApproval = false;
        if (selector === ERC20_APPROVE || selector === ERC20_INCREASE_ALLOWANCE) {
          amount = BigInt(slice(data, 36, 68));
          isApproval = true;
        } else if (selector === ERC20_TRANSFER) {
          amount = BigInt(slice(data, 36, 68));
        } else if (selector === ERC20_TRANSFER_FROM) {
          const to = getAddress(slice(data, 48, 68));
          amount = to === getAddress(account) ? 0n : BigInt(slice(data, 68, 100));
        } else {
          throw violation("not a token transfer or approval");
        }
        const t = state.tokens[target.toLowerCase()] ?? { limit: 0n, spent: 0n, approved: 0n };
        const next = isApproval ? { ...t, approved: t.approved + amount } : { ...t, spent: t.spent + amount };
        if (next.spent + next.approved > t.limit) throw violation("spending limit exceeded");
        this.policyState.set(ref.configKey, {
          ...state,
          tokens: { ...state.tokens, [target.toLowerCase()]: next },
        });
        return { validAfter: 0, validUntil: 0 };
      }
    }
  }

  private checkAction(
    session: SimSession,
    account: Address,
    target: Address,
    value: bigint,
    data: Hex,
  ): Window {
    const selector = size(data) < 4 ? VALUE_SELECTOR : slice(data, 0, 4);
    if (selector === EXECUTE && target === getAddress(account)) {
      throw new SessionValidationError("InvalidSelfCall()", "policy_denied");
    }
    if (target === FALLBACK_TARGET_FLAG) throw new SessionValidationError("InvalidTarget()", "policy_denied");
    let policies: PolicyRef[] | undefined;
    if (target === this.address) {
      policies = undefined; // FALLBACK_ACTIONID_SMARTSESSION_CALL is never configured by Agent Bank
    } else {
      policies = session.actions[actionIdOf(target, selector)];
      if (!policies || policies.length === 0) {
        policies = session.actions[actionIdOf(FALLBACK_TARGET_FLAG, FALLBACK_TARGET_SELECTOR_FLAG)];
      }
    }
    if (!policies || policies.length === 0) {
      throw new SessionValidationError(
        `NoPoliciesSet(${session.permissionId}): ${target} ${selector}`,
        "policy_denied",
      );
    }
    let window: Window = { validAfter: 0, validUntil: 0 };
    for (const ref of policies)
      window = intersect(window, this.checkActionPolicy(ref, account, target, value, data));
    return window;
  }

  /**
   * `SmartSession.validateUserOp` in USE mode: session enabled, paymaster permission, user-operation
   * policies, action policies for every execution (stateful updates), then the 2-of-2 signature.
   * Throws {@link SessionValidationError} where Smart Sessions reverts; returns `sigFailed` where it
   * returns `VALIDATION_FAILED`.
   */
  validateUserOp(
    account: Address,
    op: { callData: Hex; signature: Hex; paymaster?: Address | undefined },
    userOpHash: Hex,
    options: { skipSignature?: boolean } = {},
  ): { sigFailed: boolean; window: Window } {
    if (size(op.signature) < 33) throw new SessionValidationError("InvalidSignature()", "invalid_request");
    const mode = Number(BigInt(slice(op.signature, 0, 1)));
    if (mode !== 0)
      throw new SessionValidationError(
        "simulator: only Smart Sessions USE mode is simulated",
        "invalid_request",
      );
    const permissionId = slice(op.signature, 1, 33);
    const packedSig = size(op.signature) > 33 ? slice(op.signature, 33) : "0x";
    const session = this.get(account, permissionId);
    if (!session) throw new SessionValidationError(`InvalidPermissionId(${permissionId})`, "session_revoked");

    let minUserOpPolicies = 0;
    if (op.paymaster && op.paymaster !== zeroAddress) {
      if (!session.permitERC4337Paymaster) {
        throw new SessionValidationError(`PaymasterValidationNotEnabled(${permissionId})`, "policy_denied");
      }
      minUserOpPolicies = 1;
    }
    if (session.userOpPolicies.length < minUserOpPolicies) {
      throw new SessionValidationError(`NoPoliciesSet(${permissionId})`, "policy_denied");
    }
    let window: Window = { validAfter: 0, validUntil: 0 };
    for (const ref of session.userOpPolicies) {
      const state = this.policyState.get(ref.configKey);
      if (state?.kind === "timeFrame")
        window = intersect(window, { validAfter: state.validAfter, validUntil: state.validUntil });
      else if (state?.kind !== "sudo")
        throw new SessionValidationError(`unsupported user-operation policy ${ref.policy}`, "policy_denied");
    }

    if (size(op.callData) < 4) throw new SessionValidationError("InvalidCallData()", "policy_denied");
    const selector = slice(op.callData, 0, 4);
    if (selector === EXECUTE) {
      const [modeWord, executionCalldata] = decodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes" }],
        slice(op.callData, 4),
      );
      const m = decodeExecutionMode(modeWord);
      if (m.execType !== EXECTYPE_DEFAULT)
        throw new SessionValidationError("UnsupportedExecutionType()", "policy_denied");
      if (m.callType === CALLTYPE_BATCH) {
        const [executions] = decodeAbiParameters(
          [
            {
              type: "tuple[]",
              components: [
                { type: "address", name: "target" },
                { type: "uint256", name: "value" },
                { type: "bytes", name: "callData" },
              ],
            },
          ],
          executionCalldata,
        );
        if (executions.length === 0)
          throw new SessionValidationError("NoExecutionsInBatch()", "policy_denied");
        for (const e of executions)
          window = intersect(
            window,
            this.checkAction(session, account, getAddress(e.target), e.value, e.callData),
          );
      } else if (m.callType === CALLTYPE_SINGLE) {
        if (size(executionCalldata) < 52)
          throw new SessionValidationError("InvalidCallData()", "policy_denied");
        const target = getAddress(slice(executionCalldata, 0, 20));
        const value = BigInt(slice(executionCalldata, 20, 52));
        const data = size(executionCalldata) > 52 ? slice(executionCalldata, 52) : "0x";
        window = intersect(window, this.checkAction(session, account, target, value, data));
      } else {
        throw new SessionValidationError(`UnsupportedCallType(${m.callType})`, "policy_denied");
      }
    } else if (selector === EXECUTE_USER_OP) {
      throw new SessionValidationError("UnsupportedExecutionType()", "policy_denied");
    } else {
      window = intersect(window, this.checkAction(session, account, getAddress(account), 0n, op.callData));
    }

    if (session.sessionValidator !== getAddress(this.contracts.ownableValidator)) {
      throw new SessionValidationError(
        "simulator: only the OwnableValidator session validator is simulated",
        "invalid_request",
      );
    }
    if (options.skipSignature) return { sigFailed: false, window };
    const sigOk = validateSignatureWithData(userOpHash, packedSig, session.sessionValidatorData);
    return { sigFailed: !sigOk, window };
  }
}
