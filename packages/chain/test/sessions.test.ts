import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  getAddress,
  pad,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  getOwnableValidator,
  getPermissionId,
  getSpendingLimitsPolicy,
  getTimeFramePolicy,
  getUniversalActionPolicy,
} from "@rhinestone/module-sdk";
import {
  assertValidScope,
  buildSmartSession,
  encodeOwnableValidatorConfig,
  encodePolicyHookConfig,
  onchainScopeFromWire,
  permissionIdOf,
  policyConfigParams,
  policyHookConfig,
  SELECTORS,
  sessionLifetimeCap,
  sessionPermissionId,
  sessionSalt,
  SIMULATED_CONTRACTS as C,
  sortAddresses,
  utcDaysSpanned,
  withOwnerModules,
  OWNER_MODULE_CONTRACTS,
  type OnchainSessionScope,
  type SessionGrant,
} from "../src";

/** Smart Sessions' fallback action target (`FALLBACK_TARGET_FLAG = address(1)`). */
const FALLBACK_TARGET_FLAG = "0x0000000000000000000000000000000000000001";
import { cosigner, payee, revenue, sessionKey, USDC } from "./helpers";

const T0 = 1_791_720_000; // 2026-10-11T12:00:00Z

function grant(overrides: Partial<OnchainSessionScope> = {}): SessionGrant {
  return {
    sessionKey: sessionKey.address,
    cosigner: cosigner.address,
    salt: sessionSalt("ses_unit"),
    scope: {
      token: C.usdc,
      maxPerTx: USDC(25),
      maxPerDay: USDC(100),
      allowedRecipients: [],
      allowedContracts: [],
      issuedAt: T0,
      expiresAt: T0 + 86_400,
      ...overrides,
    },
  };
}

const emptyRules = Array.from({ length: 16 }, () => ({
  condition: 0,
  offset: 0n,
  isLimited: false,
  ref: pad("0x00", { size: 32 }) as Hex,
  usage: { limit: 0n, used: 0n },
}));

describe("session compilation", () => {
  it("builds a 2-of-2 OwnableValidator session with time-frame, per-call and lifetime policies", () => {
    const g = grant();
    const s = buildSmartSession(g, C);
    expect(s.sessionValidator).toBe(C.ownableValidator);
    const [threshold, owners] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "address[]" }],
      s.sessionValidatorInitData,
    );
    expect(threshold).toBe(2n);
    expect(owners).toEqual(sortAddresses([sessionKey.address, cosigner.address]));
    expect(s.userOpPolicies).toEqual([
      {
        policy: C.policies.timeFrame,
        initData: getTimeFramePolicy({ validUntil: T0 + 86_400, validAfter: 0 }).initData,
      },
    ]);
    expect(s.erc7739Policies).toEqual({ allowedERC7739Content: [], erc1271Policies: [] });
    expect(s.permitERC4337Paymaster).toBe(true);
    expect(s.actions).toHaveLength(1);
    const transfer = s.actions[0]!;
    expect(transfer.actionTargetSelector).toBe(SELECTORS.transfer);
    expect(transfer.actionTarget).toBe(C.usdc);
    const rules = [...emptyRules];
    rules[0] = { ...rules[0]!, condition: 4, offset: 32n, ref: pad(toHex(USDC(25)), { size: 32 }) };
    expect(transfer.actionPolicies[0]?.initData).toBe(
      getUniversalActionPolicy({ valueLimitPerUse: 0n, paramRules: { length: 1n, rules: rules as never } })
        .initData,
    );
    // A one-day session issued at noon spans two UTC days: lifetime cap = 2 x maxPerDay.
    expect(transfer.actionPolicies[1]?.initData).toBe(
      getSpendingLimitsPolicy([{ token: C.usdc, limit: USDC(200) }]).initData,
    );
  });

  it("matches module-sdk's permission id and OwnableValidator encoding", () => {
    const g = grant();
    const s = buildSmartSession(g, C);
    const sdkId = getPermissionId({ session: { ...s, chainId: 1337n } as never });
    expect(permissionIdOf(s)).toBe(sdkId);
    expect(sessionPermissionId(g, C)).toBe(sdkId);
    expect(s.sessionValidatorInitData).toBe(
      getOwnableValidator({ threshold: 2, owners: [sessionKey.address, cosigner.address] }).initData,
    );
  });

  it("pins a single recipient and a single contract, and allows each contract's functions", () => {
    const s = buildSmartSession(
      grant({ allowedRecipients: [payee], allowedContracts: [C.escrow as Address] }),
      C,
    );
    const transfer = s.actions.find((a) => a.actionTargetSelector === SELECTORS.transfer)!;
    const [config] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "uint256", name: "v" },
            {
              type: "tuple",
              name: "p",
              components: [
                { type: "uint256", name: "length" },
                {
                  type: "tuple[16]",
                  name: "rules",
                  components: [
                    { type: "uint8", name: "condition" },
                    { type: "uint64", name: "offset" },
                    { type: "bool", name: "isLimited" },
                    { type: "bytes32", name: "ref" },
                    {
                      type: "tuple",
                      name: "usage",
                      components: [
                        { type: "uint256", name: "limit" },
                        { type: "uint256", name: "used" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      transfer.actionPolicies[0]!.initData,
    );
    expect(config.p.length).toBe(2n);
    expect(config.p.rules[1]).toMatchObject({
      condition: 0,
      offset: 0n,
      ref: pad(payee.toLowerCase() as Hex, { size: 32 }),
    });
    const approve = s.actions.find((a) => a.actionTargetSelector === SELECTORS.approve);
    expect(approve).toBeDefined();
    const escrowActions = s.actions.filter((a) => a.actionTarget === C.escrow);
    expect(escrowActions.map((a) => a.actionTargetSelector)).toContain(
      toFunctionSelector("lock(address,address,uint256,uint64,address,address,bytes32,uint8,bytes32)"),
    );
    expect(escrowActions.every((a) => a.actionPolicies[0]?.policy === C.policies.sudo)).toBe(true);
    // Two recipients: no pin.
    const open = buildSmartSession(grant({ allowedRecipients: [payee, revenue] }), C);
    const [cfg2] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "uint256", name: "v" },
            { type: "tuple", name: "p", components: [{ type: "uint256", name: "length" }] },
          ],
        },
      ],
      open.actions[0]!.actionPolicies[0]!.initData,
    );
    expect(cfg2.p.length).toBe(1n);
  });

  it("validates scopes", () => {
    expect(() => buildSmartSession(grant({ maxPerTx: 0n }), C)).toThrow(/positive/);
    expect(() => buildSmartSession(grant({ expiresAt: T0 }), C)).toThrow(/after issuedAt/);
    expect(() => buildSmartSession(grant({ maxPerDay: 2n ** 128n }), C)).toThrow(/uint128/);
    expect(() => assertValidScope(grant({ allowedContracts: [payee] }).scope, C)).toThrow(
      /not an Agent Bank contract/,
    );
    expect(() => buildSmartSession({ ...grant(), cosigner: sessionKey.address }, C)).toThrow(/differ/);
    expect(() => buildSmartSession({ ...grant(), salt: "0x1234" }, C)).toThrow(/32 bytes/);
  });

  it("counts UTC days spanned for the lifetime cap", () => {
    expect(utcDaysSpanned(0, 86_400)).toBe(1n);
    expect(utcDaysSpanned(86_399, 86_401)).toBe(2n);
    expect(utcDaysSpanned(T0, T0 + 7 * 86_400)).toBe(8n);
    expect(sessionLifetimeCap({ maxPerDay: 5n, issuedAt: 0, expiresAt: 3 * 86_400 })).toBe(15n);
  });

  it("converts the API's wire scope", () => {
    const scope = onchainScopeFromWire(
      {
        asset: "USDC",
        max_per_tx: "25.00",
        max_per_day: "200.5",
        allowed_recipients: [payee.toLowerCase()],
        expires_at: "2026-10-12T12:00:00Z",
      },
      { token: C.usdc, issuedAt: T0 },
    );
    expect(scope).toEqual({
      token: C.usdc,
      maxPerTx: USDC(25),
      maxPerDay: 200_500_000n,
      allowedRecipients: [payee],
      allowedContracts: [],
      issuedAt: T0,
      expiresAt: T0 + 86_400,
    });
  });

  it("derives salts deterministically", () => {
    expect(sessionSalt("a")).toBe(sessionSalt("a"));
    expect(sessionSalt("a")).not.toBe(sessionSalt("b"));
  });
});

describe("policy hook configuration", () => {
  it("allowlists the owner modules, maps contract kinds and adds extra recipients", () => {
    const config = policyHookConfig(
      grant({ allowedRecipients: [payee], allowedContracts: [C.streams as Address, C.escrow as Address] })
        .scope,
      C,
      {
        extraRecipients: [revenue],
      },
    );
    expect(config.tokenLimits).toEqual([{ token: C.usdc, maxPerTx: USDC(25), maxPerDay: USDC(100) }]);
    expect(config.allowedRecipients).toEqual(sortAddresses([payee, revenue]));
    expect(config.recipientAllowlistEnabled).toBe(true);
    expect(config.allowedContracts).toEqual([
      { target: C.smartSessions, kind: "Generic" },
      { target: C.ownableValidator, kind: "Generic" },
      ...sortAddresses([C.escrow as Address, C.streams as Address]).map((t) => ({
        target: t,
        kind: t === C.escrow ? "AgentEscrow" : "PaymentStreams",
      })),
    ]);
    const [decoded] = decodeAbiParameters(policyConfigParams, encodePolicyHookConfig(config));
    expect(decoded.allowedContracts.map((c) => c.kind)).toEqual([
      1,
      1,
      ...config.allowedContracts.slice(2).map((c) => (c.kind === "AgentEscrow" ? 2 : 3)),
    ]);
    expect(decoded.allowedRecipients.map((a) => getAddress(a))).toEqual(config.allowedRecipients);
  });

  it("withOwnerModules adds missing owner modules as Generic and refuses another kind", () => {
    const base = policyHookConfig(grant().scope, C);
    expect(withOwnerModules(base, C)).toBe(base);
    const bare = {
      ...base,
      allowedContracts: [{ target: C.escrow as Address, kind: "AgentEscrow" as const }],
    };
    expect(withOwnerModules(bare, C).allowedContracts).toEqual([
      { target: C.smartSessions, kind: "Generic" },
      { target: C.ownableValidator, kind: "Generic" },
      { target: C.escrow, kind: "AgentEscrow" },
    ]);
    const wrong = {
      ...base,
      allowedContracts: [{ target: C.ownableValidator, kind: "AgentEscrow" as const }],
    };
    expect(() => withOwnerModules(wrong, C)).toThrow(/ownableValidator .* must be allowlisted as Generic/);
  });

  it("sessions can never reach the modules the hook allowlists for owner operations", () => {
    const ownerModules = OWNER_MODULE_CONTRACTS.map((name) => C[name].toLowerCase());
    const allContracts = [C.escrow, C.streams, C.vaults] as Address[];
    for (const overrides of [
      {},
      { allowedRecipients: [payee] },
      { allowedRecipients: [payee, revenue] },
      { allowedContracts: [C.escrow as Address] },
      { allowedContracts: allContracts, allowedRecipients: [payee, revenue] },
    ] satisfies Partial<OnchainSessionScope>[]) {
      const g = grant(overrides);
      const session = buildSmartSession(g, C);
      const targets = session.actions.map((a) => a.actionTarget.toLowerCase());
      // Every action targets the session token or an allowed Agent Bank contract.
      const allowedTargets = [g.scope.token, ...g.scope.allowedContracts].map((a) => a.toLowerCase());
      expect(targets.every((t) => allowedTargets.includes(t))).toBe(true);
      // Never the owner's modules (OwnableValidator, Smart Sessions), the policy hook or Smart
      // Sessions' fallback-action flag.
      for (const forbidden of [
        ...ownerModules,
        (C.policyHook as Address).toLowerCase(),
        FALLBACK_TARGET_FLAG,
      ]) {
        expect(targets).not.toContain(forbidden);
      }
      // The hook's Generic owner-module entries are therefore unreachable from the session path.
      const hookTargets = policyHookConfig(g.scope, C).allowedContracts.map((c) => c.target.toLowerCase());
      expect(ownerModules.every((m) => hookTargets.includes(m))).toBe(true);
    }
    expect(() => buildSmartSession(grant({ allowedContracts: [C.ownableValidator] }), C)).toThrow(
      /not an Agent Bank contract/,
    );
  });

  it("leaves the allowlist off when any recipient is allowed and rejects inverted caps", () => {
    expect(policyHookConfig(grant().scope, C).recipientAllowlistEnabled).toBe(false);
    expect(policyHookConfig(grant().scope, C).allowedRecipients).toEqual([]);
    expect(() => policyHookConfig(grant({ maxPerTx: USDC(200) }).scope, C)).toThrow(/maxPerTx <= maxPerDay/);
  });

  it("encodes OwnableValidator owners in numeric order", () => {
    const a = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
    const b = "0x1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
    const [, owners] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "address[]" }],
      encodeOwnableValidatorConfig(1, [getAddress(a), getAddress(b)]),
    );
    expect(owners).toEqual([getAddress(b), getAddress(a)]);
    expect(() => encodeOwnableValidatorConfig(3, [a, b])).toThrow(/threshold/);
    expect(() => encodeOwnableValidatorConfig(1, [a, a])).toThrow(/unique/);
  });
});
