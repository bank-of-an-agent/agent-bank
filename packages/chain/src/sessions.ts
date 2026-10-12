import {
  AgentBankError,
  decimalsOf,
  parseAmount,
  type SessionScope as WireSessionScope,
} from "@agentbank/core";
import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  isHex,
  keccak256,
  pad,
  toFunctionSelector,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { encodeOwnableValidatorConfig, sortAddresses } from "./account";
import {
  CONTRACT_KIND,
  PARAM_CONDITION,
  policyConfigParams,
  spendingLimitsInitParams,
  universalActionInitParams,
  type ContractKindName,
} from "./abis";
import type { ChainContracts } from "./types";

/**
 * Session keys on-chain.
 *
 * A session is a Smart Sessions permission whose session validator is the OwnableValidator
 * configured **2-of-2: session key + Agent Bank co-signer**. Its policies:
 *
 * - user-operation policy `TimeFramePolicy(validUntil = expiresAt)`: the EntryPoint rejects the
 *   session after expiry (and it satisfies Smart Sessions' rule that sponsored operations need a
 *   user-operation policy);
 * - `token.transfer`: `UniActionPolicy` (amount <= maxPerTx, recipient pinned when exactly one is
 *   allowed) + `ERC20SpendingLimitPolicy` (lifetime cap = maxPerDay x UTC days the session spans);
 * - `token.approve` (only when contracts are allowed): same, spender pinned when exactly one;
 * - each allowed Agent Bank contract: its user-facing functions with `SudoPolicy`;
 * - no ERC-1271 / ERC-7739 rights (ADR 0001), paymaster permitted (gas is sponsored).
 *
 * The UTC-day cap, the multi-recipient allowlist and the per-operation sum cap are enforced at the
 * account level by `AgentPolicyHook` (see {@link policyHookConfig}); Smart Sessions policies are
 * per call and cumulative only over the session's lifetime.
 */

/** On-chain session scope (bigint amounts, unix-second times). */
export interface OnchainSessionScope {
  /** ERC-20 the session may move (USDC). */
  token: Address;
  /** Max amount per call (and, in the hook, per operation). */
  maxPerTx: bigint;
  /** Max amount per UTC day (hook) and per spanned UTC day over the session's lifetime (Smart Sessions). */
  maxPerDay: bigint;
  /** Allowed recipients; empty means any recipient (the co-signer still checks its policy). */
  allowedRecipients: readonly Address[];
  /** Agent Bank contracts (escrow, streams, vaults) the session may call and approve as spender. */
  allowedContracts: readonly Address[];
  /** Unix seconds the session was issued (anchors the lifetime cap). */
  issuedAt: number;
  /** Unix seconds; the session is invalid at and after this time. */
  expiresAt: number;
}

/** Everything needed to install a session. */
export interface SessionGrant {
  /** The agent's session key address (generated client-side). */
  sessionKey: Address;
  /** Agent Bank co-signer address. */
  cosigner: Address;
  /** 32-byte salt that makes the permission id unique, e.g. `sessionSalt(sessionId)`. */
  salt: Hex;
  scope: OnchainSessionScope;
}

/** Smart Sessions `PolicyData`. */
export interface PolicyData {
  policy: Address;
  initData: Hex;
}

/** Smart Sessions `ActionData`. */
export interface ActionData {
  actionTargetSelector: Hex;
  actionTarget: Address;
  actionPolicies: readonly PolicyData[];
}

/** Smart Sessions `Session` struct (the `enableSessions` argument). */
export interface SmartSession {
  sessionValidator: Address;
  sessionValidatorInitData: Hex;
  salt: Hex;
  userOpPolicies: readonly PolicyData[];
  erc7739Policies: {
    allowedERC7739Content: readonly { appDomainSeparator: Hex; contentName: readonly string[] }[];
    erc1271Policies: readonly PolicyData[];
  };
  actions: readonly ActionData[];
  permitERC4337Paymaster: boolean;
}

/** ERC-20 selectors sessions are scoped on. */
export const SELECTORS = {
  transfer: toFunctionSelector("transfer(address,uint256)"),
  approve: toFunctionSelector("approve(address,uint256)"),
  transferFrom: toFunctionSelector("transferFrom(address,address,uint256)"),
} as const;

/** User-facing functions a session may call on each kind of Agent Bank contract. */
export const CONTRACT_SELECTORS = {
  escrow: [
    "lock(address,address,uint256,uint64,address,address,bytes32,uint8,bytes32)",
    "release(uint256)",
    "releaseByValidation(uint256)",
    "refund(uint256)",
    "dispute(uint256)",
    "resolve(uint256,uint256)",
  ],
  streams: [
    "createStream(address,address,uint256,uint256,uint64,uint64,uint64)",
    "topUp(uint256,uint256)",
    "settle(uint256)",
    "cancel(uint256)",
  ],
  vaults: [
    "createVault(address,uint64,address)",
    "deposit(uint256,uint256)",
    "withdraw(uint256,uint256)",
    "withdrawWithSignature(uint256,uint256,uint256,bytes)",
  ],
} as const;

const SECONDS_PER_DAY = 86_400;
const UINT128_MAX = 2n ** 128n - 1n;

/** A deterministic 32-byte session salt from an identifier (e.g. the `ses_…` id). */
export function sessionSalt(id: string): Hex {
  return keccak256(toHex(`agentbank.session:${id}`));
}

/** Smart Sessions permission id: `keccak256(abi.encode(sessionValidator, sessionValidatorInitData, salt))`. */
export function permissionIdOf(
  session: Pick<SmartSession, "sessionValidator" | "sessionValidatorInitData" | "salt">,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }],
      [session.sessionValidator, session.sessionValidatorInitData, session.salt],
    ),
  );
}

/** Number of UTC days `[issuedAt, expiresAt)` touches (at least 1). */
export function utcDaysSpanned(issuedAt: number, expiresAt: number): bigint {
  const first = Math.floor(issuedAt / SECONDS_PER_DAY);
  const last = Math.floor((expiresAt - 1) / SECONDS_PER_DAY);
  return BigInt(Math.max(1, last - first + 1));
}

/** Lifetime cap the session's spending-limit policies carry: maxPerDay x UTC days spanned. */
export function sessionLifetimeCap(
  scope: Pick<OnchainSessionScope, "maxPerDay" | "issuedAt" | "expiresAt">,
): bigint {
  return scope.maxPerDay * utcDaysSpanned(scope.issuedAt, scope.expiresAt);
}

/** Which Agent Bank contract an address is, given the chain's contracts. */
export function agentBankContractKind(
  address: Address,
  contracts: ChainContracts,
): "escrow" | "streams" | "vaults" | null {
  const a = address.toLowerCase();
  if (contracts.escrow?.toLowerCase() === a) return "escrow";
  if (contracts.streams?.toLowerCase() === a) return "streams";
  if (contracts.vaults?.toLowerCase() === a) return "vaults";
  return null;
}

function assertUnixSeconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value >= 2 ** 48) {
    throw new AgentBankError("invalid_request", `${field} must be unix seconds`);
  }
}

/** Validate a scope; throws `invalid_request`. */
export function assertValidScope(scope: OnchainSessionScope, contracts: ChainContracts): void {
  assertUnixSeconds(scope.issuedAt, "issuedAt");
  assertUnixSeconds(scope.expiresAt, "expiresAt");
  if (scope.expiresAt <= scope.issuedAt)
    throw new AgentBankError("invalid_request", "expiresAt must be after issuedAt");
  if (scope.maxPerTx <= 0n || scope.maxPerDay <= 0n) {
    throw new AgentBankError("invalid_request", "maxPerTx and maxPerDay must be positive");
  }
  if (scope.maxPerTx > UINT128_MAX || scope.maxPerDay > UINT128_MAX) {
    throw new AgentBankError("invalid_request", "limits must fit in uint128");
  }
  for (const c of scope.allowedContracts) {
    if (agentBankContractKind(c, contracts) === null) {
      throw new AgentBankError(
        "invalid_request",
        `allowedContracts: ${c} is not an Agent Bank contract on this chain`,
      );
    }
  }
}

function word(value: bigint | Address): Hex {
  return pad(toHex(typeof value === "bigint" ? value : BigInt(value)), { size: 32 });
}

interface UniRule {
  condition: number;
  offset: bigint;
  ref: Hex;
}

/** `abi.encode(ActionConfig)` for UniActionPolicy (no native value, 16 rule slots). */
export function encodeUniActionConfig(rules: readonly UniRule[]): Hex {
  if (rules.length === 0 || rules.length > 16) throw new RangeError("UniActionPolicy takes 1..16 rules");
  const empty = { condition: 0, offset: 0n, isLimited: false, ref: zeroHash, usage: { limit: 0n, used: 0n } };
  const slots = Array.from({ length: 16 }, (_, i) => {
    const r = rules[i];
    return r ? { ...empty, condition: r.condition, offset: r.offset, ref: r.ref } : empty;
  });
  const config = { valueLimitPerUse: 0n, paramRules: { length: BigInt(rules.length), rules: slots } };
  // `rules` is a fixed `tuple[16]`; the array above always has exactly 16 entries.
  return encodeAbiParameters(universalActionInitParams, [config as never]);
}

/** `abi.encode(address[] tokens, uint256[] limits)` for ERC20SpendingLimitPolicy. */
export function encodeSpendingLimits(token: Address, limit: bigint): Hex {
  return encodeAbiParameters(spendingLimitsInitParams, [[token], [limit]]);
}

/** `abi.encodePacked(uint48 validUntil, uint48 validAfter)` for TimeFramePolicy. */
export function encodeTimeFrame(validUntil: number, validAfter: number): Hex {
  return encodePacked(["uint48", "uint48"], [validUntil, validAfter]);
}

/** Compile a session grant into the Smart Sessions `Session` struct Agent Bank installs. */
export function buildSmartSession(grant: SessionGrant, contracts: ChainContracts): SmartSession {
  const { scope } = grant;
  assertValidScope(scope, contracts);
  if (!isHex(grant.salt) || grant.salt.length !== 66)
    throw new AgentBankError("invalid_request", "salt must be 32 bytes");
  const sessionKey = getAddress(grant.sessionKey);
  const cosigner = getAddress(grant.cosigner);
  if (sessionKey === cosigner)
    throw new AgentBankError("invalid_request", "session key and co-signer must differ");

  const token = getAddress(scope.token);
  const recipients = sortAddresses(scope.allowedRecipients);
  const allowedContracts = sortAddresses(scope.allowedContracts);
  const lifetimeCap = sessionLifetimeCap(scope);
  const spendingLimit: PolicyData = {
    policy: contracts.policies.spendingLimits,
    initData: encodeSpendingLimits(token, lifetimeCap),
  };

  const transferRules: UniRule[] = [
    { condition: PARAM_CONDITION.LESS_THAN_OR_EQUAL, offset: 32n, ref: word(scope.maxPerTx) },
  ];
  if (recipients.length === 1) {
    transferRules.push({ condition: PARAM_CONDITION.EQUAL, offset: 0n, ref: word(recipients[0] as Address) });
  }
  const actions: ActionData[] = [
    {
      actionTargetSelector: SELECTORS.transfer,
      actionTarget: token,
      actionPolicies: [
        { policy: contracts.policies.universalAction, initData: encodeUniActionConfig(transferRules) },
        spendingLimit,
      ],
    },
  ];
  if (allowedContracts.length > 0) {
    const approveRules: UniRule[] = [
      { condition: PARAM_CONDITION.LESS_THAN_OR_EQUAL, offset: 32n, ref: word(scope.maxPerTx) },
    ];
    if (allowedContracts.length === 1) {
      approveRules.push({
        condition: PARAM_CONDITION.EQUAL,
        offset: 0n,
        ref: word(allowedContracts[0] as Address),
      });
    }
    actions.push({
      actionTargetSelector: SELECTORS.approve,
      actionTarget: token,
      actionPolicies: [
        { policy: contracts.policies.universalAction, initData: encodeUniActionConfig(approveRules) },
        spendingLimit,
      ],
    });
  }
  for (const target of allowedContracts) {
    const kind = agentBankContractKind(target, contracts) as keyof typeof CONTRACT_SELECTORS;
    for (const signature of CONTRACT_SELECTORS[kind]) {
      actions.push({
        actionTargetSelector: toFunctionSelector(signature),
        actionTarget: target,
        actionPolicies: [{ policy: contracts.policies.sudo, initData: "0x" }],
      });
    }
  }

  return {
    sessionValidator: contracts.ownableValidator,
    sessionValidatorInitData: encodeOwnableValidatorConfig(2, [sessionKey, cosigner]),
    salt: grant.salt,
    userOpPolicies: [{ policy: contracts.policies.timeFrame, initData: encodeTimeFrame(scope.expiresAt, 0) }],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions,
    permitERC4337Paymaster: true,
  };
}

/** Permission id of the session a grant compiles to. */
export function sessionPermissionId(grant: SessionGrant, contracts: ChainContracts): Hex {
  return permissionIdOf({
    sessionValidator: contracts.ownableValidator,
    sessionValidatorInitData: encodeOwnableValidatorConfig(2, [grant.sessionKey, grant.cosigner]),
    salt: grant.salt,
  });
}

/**
 * Convert the API's wire `SessionScope` (decimal strings, ISO timestamps; see `@agentbank/core`)
 * into an {@link OnchainSessionScope}.
 */
export function onchainScopeFromWire(
  scope: WireSessionScope,
  options: { token: Address; issuedAt: number },
): OnchainSessionScope {
  const decimals = decimalsOf(scope.asset);
  const expiresMs = Date.parse(scope.expires_at);
  if (Number.isNaN(expiresMs)) throw new AgentBankError("invalid_request", "expires_at is not a timestamp");
  return {
    token: getAddress(options.token),
    maxPerTx: parseAmount(scope.max_per_tx, decimals),
    maxPerDay: parseAmount(scope.max_per_day, decimals),
    allowedRecipients: (scope.allowed_recipients ?? []).map((a) => getAddress(a)),
    allowedContracts: (scope.allowed_contracts ?? []).map((a) => getAddress(a)),
    issuedAt: options.issuedAt,
    expiresAt: Math.floor(expiresMs / 1000),
  };
}

// ---------------------------------------------------------------------------------------------- policy hook

/** `IAgentPolicyHook.PolicyConfig` in TypeScript form. */
export interface PolicyHookConfig {
  tokenLimits: readonly { token: Address; maxPerTx: bigint; maxPerDay: bigint }[];
  allowedRecipients: readonly Address[];
  allowedContracts: readonly { target: Address; kind: ContractKindName }[];
  recipientAllowlistEnabled: boolean;
}

/**
 * Modules owner operations call, which `AgentPolicyHook` must allowlist as `Generic` contracts (it
 * hooks owner operations too): Smart Sessions (enable/remove sessions) and the OwnableValidator
 * (owner key rotation). The hook does not interpret calls to Generic targets, and neither module
 * holds or pulls funds. Like every allowlisted contract, they also pass the hook's recipient and
 * spender checks, so recipients must still be checked against the session scope (Smart Sessions
 * pins a single recipient; the co-signer checks the rest).
 */
export const OWNER_MODULE_CONTRACTS = [
  "smartSessions",
  "ownableValidator",
] as const satisfies readonly (keyof ChainContracts)[];

/**
 * `config` with every {@link OWNER_MODULE_CONTRACTS} module allowlisted as `Generic` (missing entries
 * are added first). Throws `invalid_request` if one is allowlisted with another kind.
 */
export function withOwnerModules(config: PolicyHookConfig, contracts: ChainContracts): PolicyHookConfig {
  const missing: { target: Address; kind: ContractKindName }[] = [];
  for (const name of OWNER_MODULE_CONTRACTS) {
    const target = getAddress(contracts[name]);
    const entry = config.allowedContracts.find((c) => getAddress(c.target) === target);
    if (!entry) missing.push({ target, kind: "Generic" });
    else if (entry.kind !== "Generic") {
      throw new AgentBankError(
        "invalid_request",
        `${name} (${target}) must be allowlisted as Generic, not ${entry.kind}`,
      );
    }
  }
  return missing.length === 0
    ? config
    : { ...config, allowedContracts: [...missing, ...config.allowedContracts] };
}

/**
 * Account-level `AgentPolicyHook` configuration for an agent account, derived from a session scope:
 * the token's per-operation and UTC-day caps, the recipient allowlist (plus `extraRecipients`, e.g.
 * the Agent Bank revenue address for batched fees and the agent's x402 spend key), the allowed Agent
 * Bank contracts with their kinds, and the owner's modules as `Generic` contracts (see
 * {@link OWNER_MODULE_CONTRACTS}): Smart Sessions, so owner operations can enable and remove
 * sessions, and the OwnableValidator, so they can rotate the owner key (`ownerRotationCalls`).
 * Sessions can never call either: Smart Sessions configures no action on them (see
 * {@link buildSmartSession}) and the co-signer refuses such calls.
 *
 * Caps apply to the sum of a token's outflows in one operation, fees included: compile scopes with
 * fee headroom.
 */
export function policyHookConfig(
  scope: Pick<
    OnchainSessionScope,
    "token" | "maxPerTx" | "maxPerDay" | "allowedRecipients" | "allowedContracts"
  >,
  contracts: ChainContracts,
  options: { extraRecipients?: readonly Address[] } = {},
): PolicyHookConfig {
  if (scope.maxPerTx <= 0n || scope.maxPerTx > scope.maxPerDay || scope.maxPerDay > UINT128_MAX) {
    throw new AgentBankError("invalid_request", "hook limits need 0 < maxPerTx <= maxPerDay < 2^128");
  }
  const kinds: Record<"escrow" | "streams" | "vaults", ContractKindName> = {
    escrow: "AgentEscrow",
    streams: "PaymentStreams",
    vaults: "TimeLockVaults",
  };
  const allowedContracts: { target: Address; kind: ContractKindName }[] = OWNER_MODULE_CONTRACTS.map(
    (name) => ({ target: getAddress(contracts[name]), kind: "Generic" }),
  );
  for (const target of sortAddresses(scope.allowedContracts)) {
    const kind = agentBankContractKind(target, contracts);
    if (kind === null) throw new AgentBankError("invalid_request", `${target} is not an Agent Bank contract`);
    allowedContracts.push({ target, kind: kinds[kind] });
  }
  const recipientAllowlistEnabled = scope.allowedRecipients.length > 0;
  return {
    tokenLimits: [{ token: getAddress(scope.token), maxPerTx: scope.maxPerTx, maxPerDay: scope.maxPerDay }],
    allowedRecipients: recipientAllowlistEnabled
      ? sortAddresses([...scope.allowedRecipients, ...(options.extraRecipients ?? [])])
      : [],
    allowedContracts,
    recipientAllowlistEnabled,
  };
}

/** `abi.encode(PolicyConfig)`: the hook's `onInstall` data. */
export function encodePolicyHookConfig(config: PolicyHookConfig): Hex {
  return encodeAbiParameters(policyConfigParams, [
    {
      tokenLimits: config.tokenLimits.map((l) => ({
        token: l.token,
        maxPerTx: l.maxPerTx,
        maxPerDay: l.maxPerDay,
      })),
      allowedRecipients: [...config.allowedRecipients],
      allowedContracts: config.allowedContracts.map((c) => ({
        target: c.target,
        kind: CONTRACT_KIND[c.kind],
      })),
      recipientAllowlistEnabled: config.recipientAllowlistEnabled,
    },
  ]);
}
