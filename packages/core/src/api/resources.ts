import { z } from "zod";
import { OpenPaymentMandateSchema } from "../mandate-schema";
import {
  PAYMENT_KINDS,
  PolicyDecisionSchema,
  PolicyDocumentSchema,
  SessionScopeSchema,
} from "../policy-schema";
import {
  AddressSchema,
  AssetCodeSchema,
  Bytes32Schema,
  ChainNameSchema,
  DecimalString,
  DomainSchema,
  HexSchema,
  idSchema,
  MoneySchema,
  OwnerAuthorizationSchema,
  SignedDecimalString,
  TimestampSchema,
} from "../schemas";
import { WEBHOOK_EVENT_TYPES } from "../webhooks";

/**
 * Resource schemas of the public REST API (v1). These are the wire shapes:
 * snake_case, money as decimal strings, ids prefixed. Route definitions in
 * `routes.ts` reference these, and the OpenAPI 3.1 document is generated
 * from them, so the implementation, the docs and the SDKs cannot drift.
 */

const Metadata = z
  .record(z.string().max(64), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, "at most 20 metadata keys")
  .meta({ description: "Up to 20 string key/value pairs for your own references." });

// ---------------------------------------------------------------- orgs

export const KycStatus = z.enum(["pending", "in_review", "approved", "rejected"]);
export const OrgTier = z.enum(["free", "pro", "business", "enterprise"]);

export const Org = z
  .object({
    id: idSchema("org"),
    object: z.literal("org"),
    legal_name: z.string(),
    kind: z.enum(["individual", "company"]),
    country: z.string().length(2),
    kyc_status: KycStatus,
    tier: OrgTier,
    status: z.enum(["active", "frozen"]),
    owner_address: AddressSchema.meta({
      description: "The principal's owner key. Can always exit; never held by Agent Bank.",
    }),
    treasury_account_id: idSchema("account").nullable(),
    created_at: TimestampSchema,
  })
  .meta({ id: "Org", description: "A verified principal (human or company) that owns agents." });

export const CreateOrgRequest = z
  .object({
    legal_name: z.string().min(1).max(200),
    kind: z.enum(["individual", "company"]),
    country: z.string().length(2).toUpperCase(),
    contact_email: z.email(),
    owner_address: AddressSchema,
  })
  .meta({ id: "CreateOrgRequest" });

export const ApiKey = z
  .object({
    id: idSchema("apiKey"),
    object: z.literal("api_key"),
    name: z.string(),
    prefix: z.string().meta({ description: "First characters of the key, for display" }),
    scopes: z.array(z.string()),
    created_at: TimestampSchema,
    revoked_at: TimestampSchema.nullable(),
  })
  .meta({ id: "ApiKey" });

export const ApiKeyWithSecret = ApiKey.extend({
  secret: z.string().meta({ description: "Shown once. Store it in your secret manager." }),
}).meta({ id: "ApiKeyWithSecret" });

export const CreateOrgResponse = z
  .object({ org: Org, api_key: ApiKeyWithSecret })
  .meta({ id: "CreateOrgResponse" });

export const CreateApiKeyRequest = z
  .object({
    name: z.string().min(1).max(100),
    scopes: z
      .array(
        z.enum([
          "admin",
          "agents:write",
          "payments:read",
          "approvals:decide",
          "ledger:read",
          "webhooks:write",
        ]),
      )
      .min(1)
      .default(["admin"]),
  })
  .meta({ id: "CreateApiKeyRequest" });

export const KybSession = z
  .object({
    org_id: idSchema("org"),
    provider: z.string(),
    status: KycStatus,
    verification_url: z.url().nullable(),
  })
  .meta({ id: "KybSession" });

export const FreezeRequest = z.object({ reason: z.string().min(1).max(500) }).meta({ id: "FreezeRequest" });

export const UnfreezeRequest = z
  .object({ reason: z.string().min(1).max(500), owner_authorization: OwnerAuthorizationSchema })
  .meta({
    id: "UnfreezeRequest",
    description: "Unfreezing is a loosening change: owner signature plus 1-hour delay.",
  });

export const SetTreasuryRequest = z
  .object({ account_id: idSchema("account"), owner_authorization: OwnerAuthorizationSchema })
  .meta({ id: "SetTreasuryRequest" });

// ---------------------------------------------------------------- members

export const MemberRole = z.enum(["admin", "approver", "viewer"]);
export const Member = z
  .object({
    id: idSchema("member"),
    object: z.literal("member"),
    org_id: idSchema("org"),
    email: z.email(),
    role: MemberRole,
    passkey_count: z.number().int().nonnegative(),
    created_at: TimestampSchema,
  })
  .meta({ id: "Member" });

export const CreateMemberRequest = z
  .object({ email: z.email(), role: MemberRole })
  .meta({ id: "CreateMemberRequest" });

// ---------------------------------------------------------------- agents

export const Agent = z
  .object({
    id: idSchema("agent"),
    object: z.literal("agent"),
    org_id: idSchema("org"),
    name: z.string(),
    description: z.string().nullable(),
    did: z.string().nullable().meta({ description: "did:pkh of the agent's primary account once created" }),
    erc8004_id: z.string().nullable(),
    agent_card_url: z.url().nullable(),
    status: z.enum(["active", "frozen"]),
    frozen_reason: z.string().nullable(),
    pending_unfreeze_at: TimestampSchema.nullable(),
    metadata: Metadata,
    created_at: TimestampSchema,
  })
  .meta({ id: "Agent", description: "A software identity acting for a principal." });

export const CreateAgentRequest = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    erc8004_id: z.string().max(200).optional(),
    agent_card_url: z.url().optional(),
    metadata: Metadata.optional(),
  })
  .meta({ id: "CreateAgentRequest" });

// ---------------------------------------------------------------- accounts

export const Account = z
  .object({
    id: idSchema("account"),
    object: z.literal("account"),
    agent_id: idSchema("agent").nullable().meta({ description: "Null for an org treasury account" }),
    org_id: idSchema("org"),
    role: z.enum(["agent", "treasury"]),
    chain: ChainNameSchema,
    chain_id: z.number().int(),
    address: AddressSchema.meta({
      description: "Counterfactual (CREATE2) smart account address; can receive funds before deployment",
    }),
    deployed: z.boolean(),
    owner_address: AddressSchema,
    spend_key_address: AddressSchema.nullable().meta({
      description: "Per-agent x402 spend key holding a small float (see ADR 0001)",
    }),
    module_versions: z.record(z.string(), z.string()),
    created_at: TimestampSchema,
  })
  .meta({ id: "Account", description: "One ERC-7579 smart account per agent per chain." });

export const CreateAccountRequest = z
  .object({
    chain: ChainNameSchema.default("base-sepolia"),
    spend_key_address: AddressSchema.optional().meta({
      description: "Address of the agent's x402 spend key, generated client-side by the SDK",
    }),
  })
  .meta({ id: "CreateAccountRequest" });

export const CreateTreasuryAccountRequest = z
  .object({ chain: ChainNameSchema.default("base-sepolia") })
  .meta({ id: "CreateTreasuryAccountRequest" });

export const VaultBalance = z.object({
  vault_id: idSchema("vault"),
  name: z.string(),
  balance: DecimalString,
});

export const Balances = z
  .object({
    object: z.literal("balances"),
    account_id: idSchema("account"),
    asset: AssetCodeSchema,
    available: DecimalString.meta({ description: "Spendable now (operating pocket)" }),
    reserved: DecimalString.meta({ description: "Held for pending payments" }),
    escrow: DecimalString.meta({ description: "Locked in escrow contracts" }),
    fees: DecimalString.meta({ description: "Fees accrued and owed" }),
    savings: DecimalString.meta({ description: "Goal and locked vaults" }),
    spend_float: DecimalString.meta({ description: "Float held by the x402 spend key" }),
    vaults: z.array(VaultBalance),
    total: DecimalString,
    as_of: TimestampSchema,
  })
  .meta({ id: "Balances" });

// ---------------------------------------------------------------- owner operations

export const OwnerOperation = z
  .object({
    id: idSchema("ownerOperation"),
    object: z.literal("owner_operation"),
    account_id: idSchema("account"),
    purpose: z.enum([
      "session.install",
      "session.revoke",
      "topup.configure",
      "sweep.configure",
      "vault.withdraw",
      "payment",
      "account.deploy",
    ]),
    subject_id: z
      .string()
      .meta({ description: "The session, payment, vault or rule this operation applies to" }),
    status: z.enum(["requires_signature", "submitted", "succeeded", "failed", "expired"]),
    user_op_hash: Bytes32Schema.meta({
      description: "Sign this hash with the owner key (EIP-191 personal sign)",
    }),
    chain_id: z.number().int(),
    tx_hash: Bytes32Schema.nullable(),
    expires_at: TimestampSchema,
    created_at: TimestampSchema,
  })
  .meta({
    id: "OwnerOperation",
    description:
      "An on-chain operation only the principal's owner key can authorize (installing a session, configuring executors, early vault withdrawal). Agent Bank cannot sign it.",
  });

export const SubmitOwnerSignatureRequest = z
  .object({ signature: HexSchema.meta({ description: "Owner key signature over user_op_hash" }) })
  .meta({ id: "SubmitOwnerSignatureRequest" });

// ---------------------------------------------------------------- sessions

export const Session = z
  .object({
    id: idSchema("session"),
    object: z.literal("session"),
    account_id: idSchema("account"),
    public_key: AddressSchema.meta({ description: "Session key address (secp256k1), generated client-side" }),
    scope: SessionScopeSchema,
    status: z.enum(["pending_install", "active", "expired", "revoked"]),
    expires_at: TimestampSchema,
    revoked_at: TimestampSchema.nullable(),
    onchain_tx: HexSchema.nullable(),
    install_operation_id: idSchema("ownerOperation")
      .nullable()
      .meta({ description: "Owner operation that installs the session on-chain (Smart Sessions)" }),
    created_at: TimestampSchema,
  })
  .meta({ id: "Session", description: "A short-lived, scoped agent key. Useless without the co-signer." });

export const CreateSessionRequest = z
  .object({
    account_id: idSchema("account"),
    public_key: AddressSchema,
    scope: SessionScopeSchema,
    owner_authorization: OwnerAuthorizationSchema.meta({
      description: 'OwnerAuthorization with action "session.grant" over {account_id, public_key, scope}',
    }),
  })
  .meta({ id: "CreateSessionRequest" });

// ---------------------------------------------------------------- mandates

export const Mandate = z
  .object({
    id: idSchema("mandate"),
    object: z.literal("mandate"),
    agent_id: idSchema("agent"),
    signer: AddressSchema,
    mandate: OpenPaymentMandateSchema,
    status: z.enum(["active", "expired", "revoked"]),
    expires_at: TimestampSchema,
    spent: DecimalString.meta({ description: "Cumulative spend under this mandate (for payment.budget)" }),
    created_at: TimestampSchema,
  })
  .meta({ id: "Mandate", description: "An AP2 open Payment Mandate signed by the principal." });

export const CreateMandateRequest = z
  .object({
    agent_id: idSchema("agent"),
    mandate: OpenPaymentMandateSchema,
    owner_authorization: OwnerAuthorizationSchema.meta({
      description: 'OwnerAuthorization with action "mandate.issue" over the mandate object',
    }),
  })
  .meta({ id: "CreateMandateRequest" });

// ---------------------------------------------------------------- policies

export const PolicyVersion = z
  .object({
    id: idSchema("policy"),
    object: z.literal("policy"),
    agent_id: idSchema("agent"),
    version: z.number().int().positive(),
    rules: PolicyDocumentSchema,
    change_kind: z.enum(["initial", "tighten", "loosen", "mixed", "unchanged"]),
    effective_at: TimestampSchema,
    signed_by: AddressSchema.nullable(),
    created_at: TimestampSchema,
  })
  .meta({ id: "PolicyVersion" });

export const AgentPolicy = z
  .object({
    object: z.literal("agent_policy"),
    agent_id: idSchema("agent"),
    current: PolicyVersion.nullable(),
    pending: PolicyVersion.nullable().meta({
      description: "A loosening change waiting out its 1-hour delay",
    }),
  })
  .meta({ id: "AgentPolicy" });

export const PutPolicyRequest = z
  .object({
    policy: PolicyDocumentSchema,
    owner_authorization: OwnerAuthorizationSchema.optional().meta({
      description:
        'Required when the change loosens any rule: action "policy.loosen" over the policy document',
    }),
  })
  .meta({ id: "PutPolicyRequest" });

export const PaymentIntent = z
  .object({
    kind: z.enum(PAYMENT_KINDS).default("transfer"),
    amount: MoneySchema,
    to_address: AddressSchema.optional(),
    to_agent_id: idSchema("agent").optional(),
    erc8004_id: z.string().optional(),
    x402_domain: DomainSchema.optional(),
    mandate_id: idSchema("mandate").optional(),
  })
  .meta({ id: "PaymentIntent", description: "What a payment would do, for dry-run policy checks." });

export const PolicyCheckRequest = z
  .object({ account_id: idSchema("account"), intent: PaymentIntent })
  .meta({ id: "PolicyCheckRequest" });

// ---------------------------------------------------------------- payments

export const PaymentStatus = z.enum([
  "requires_approval",
  "requires_signature",
  "submitted",
  "settled",
  "denied",
  "failed",
  "canceled",
  "expired",
]);

export const Counterparty = z
  .object({
    type: z.enum(["address", "agent", "x402", "escrow", "stream"]),
    address: AddressSchema,
    agent_id: idSchema("agent").nullable(),
    x402_domain: DomainSchema.nullable(),
  })
  .meta({ id: "Counterparty" });

export const SigningRequest = z
  .object({
    session_id: idSchema("session").nullable(),
    user_op_hash: Bytes32Schema.meta({
      description: "Sign this hash with the session key (EIP-191 personal sign)",
    }),
    chain_id: z.number().int(),
    expires_at: TimestampSchema,
  })
  .meta({
    id: "SigningRequest",
    description: "What the agent's session key must sign to submit the operation.",
  });

export const Payment = z
  .object({
    id: idSchema("payment"),
    object: z.literal("payment"),
    account_id: idSchema("account"),
    kind: z.enum(PAYMENT_KINDS),
    status: PaymentStatus,
    amount: MoneySchema,
    fee: MoneySchema,
    counterparty: Counterparty,
    memo: z.string().nullable(),
    mandate_id: idSchema("mandate").nullable(),
    payment_request_id: idSchema("paymentRequest").nullable(),
    decision: PolicyDecisionSchema.nullable(),
    approval_id: idSchema("approval").nullable(),
    signing_request: SigningRequest.nullable(),
    owner_operation_id: idSchema("ownerOperation")
      .nullable()
      .meta({ description: "Set when policy requires the owner key to sign this payment itself" }),
    user_op_hash: Bytes32Schema.nullable(),
    tx_hash: Bytes32Schema.nullable(),
    failure_reason: z.string().nullable(),
    metadata: Metadata,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    settled_at: TimestampSchema.nullable(),
  })
  .meta({ id: "Payment" });

export const CreatePaymentRequest = z
  .object({
    account_id: idSchema("account"),
    amount: MoneySchema,
    to: z
      .object({
        address: AddressSchema.optional(),
        agent_id: idSchema("agent").optional(),
        account_id: idSchema("account").optional(),
      })
      .refine((t) => [t.address, t.agent_id, t.account_id].filter(Boolean).length === 1, {
        message: "set exactly one of to.address, to.agent_id, to.account_id",
      }),
    memo: z.string().max(500).optional(),
    mandate_id: idSchema("mandate").optional(),
    payment_request_id: idSchema("paymentRequest").optional(),
    metadata: Metadata.optional(),
  })
  .meta({ id: "CreatePaymentRequest" });

export const SubmitSignatureRequest = z
  .object({
    session_id: idSchema("session"),
    signature: HexSchema.meta({ description: "Session key signature over signing_request.user_op_hash" }),
  })
  .meta({ id: "SubmitSignatureRequest" });

export const PaymentRequest = z
  .object({
    id: idSchema("paymentRequest"),
    object: z.literal("payment_request"),
    account_id: idSchema("account"),
    pay_to: AddressSchema,
    amount: MoneySchema,
    memo: z.string().nullable(),
    reference: z.string().nullable(),
    status: z.enum(["open", "paid", "expired", "canceled"]),
    pay_link: z.string(),
    paid_by_payment_id: idSchema("payment").nullable(),
    expires_at: TimestampSchema,
    created_at: TimestampSchema,
  })
  .meta({ id: "PaymentRequest", description: "A request for another agent or a human to pay." });

export const CreatePaymentRequestRequest = z
  .object({
    account_id: idSchema("account"),
    amount: MoneySchema,
    memo: z.string().max(500).optional(),
    reference: z.string().max(200).optional(),
    expires_in_seconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 3600)
      .default(7 * 24 * 3600),
  })
  .meta({ id: "CreatePaymentRequestRequest" });

// ---------------------------------------------------------------- x402

export const X402PaymentRequirements = z
  .object({
    scheme: z.string(),
    network: z.string().meta({ description: 'CAIP-2 network, e.g. "eip155:84532"' }),
    asset: AddressSchema,
    amount: z
      .string()
      .regex(/^[0-9]+$/)
      .meta({ description: "Atomic token units" }),
    payTo: AddressSchema,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()).default({}),
  })
  .meta({ id: "X402PaymentRequirements", description: "x402 v2 PaymentRequirements" });

export const X402ResourceInfo = z
  .object({ url: z.url(), description: z.string().optional(), mimeType: z.string().optional() })
  .loose()
  .meta({ id: "X402ResourceInfo" });

export const X402PaymentPayload = z
  .object({
    x402Version: z.number().int(),
    resource: X402ResourceInfo.optional(),
    accepted: X402PaymentRequirements,
    payload: z.record(z.string(), z.unknown()),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "X402PaymentPayload", description: "x402 v2 PaymentPayload" });

export const Eip3009Authorization = z
  .object({
    from: AddressSchema,
    to: AddressSchema,
    value: z.string().regex(/^[0-9]+$/),
    validAfter: z.string().regex(/^[0-9]+$/),
    validBefore: z.string().regex(/^[0-9]+$/),
    nonce: Bytes32Schema,
  })
  .meta({ id: "Eip3009Authorization" });

export const X402PayRequest = z
  .object({
    account_id: idSchema("account"),
    resource: X402ResourceInfo,
    requirements: X402PaymentRequirements,
    mandate_id: idSchema("mandate").optional(),
  })
  .meta({ id: "X402PayRequest" });

export const X402PayResponse = z
  .object({
    object: z.literal("x402_authorization"),
    payment: Payment,
    authorization: Eip3009Authorization.nullable().meta({
      description: "When status is requires_signature: sign this EIP-3009 authorization with the spend key",
    }),
    eip712_domain: z
      .object({
        name: z.string(),
        version: z.string(),
        chainId: z.number().int(),
        verifyingContract: AddressSchema,
      })
      .nullable(),
  })
  .meta({ id: "X402PayResponse" });

export const X402VerifyRequest = z
  .object({
    x402Version: z.number().int(),
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  })
  .meta({ id: "X402VerifyRequest" });

export const X402VerifyResponse = z
  .object({
    isValid: z.boolean(),
    invalidReason: z.string().optional(),
    invalidMessage: z.string().optional(),
    payer: z.string().optional(),
  })
  .meta({ id: "X402VerifyResponse" });

export const X402SettleResponse = z
  .object({
    success: z.boolean(),
    errorReason: z.string().optional(),
    errorMessage: z.string().optional(),
    payer: z.string().optional(),
    transaction: z.string(),
    network: z.string(),
    amount: z.string().optional(),
  })
  .meta({ id: "X402SettleResponse" });

export const X402SupportedResponse = z
  .object({
    kinds: z.array(
      z.object({
        x402Version: z.number().int(),
        scheme: z.string(),
        network: z.string(),
        extra: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    extensions: z.array(z.string()),
    signers: z.record(z.string(), z.array(z.string())),
  })
  .meta({ id: "X402SupportedResponse" });

export const X402Payee = z
  .object({
    object: z.literal("x402_payee"),
    account_id: idSchema("account"),
    pay_to: AddressSchema,
    domains: z.array(DomainSchema),
    facilitator_url: z.string(),
    fee_bps: z.number().int(),
    created_at: TimestampSchema,
  })
  .meta({ id: "X402Payee", description: "Seller configuration for charging per call (x402 receive)." });

export const RegisterX402PayeeRequest = z
  .object({ account_id: idSchema("account"), domains: z.array(DomainSchema).min(1).max(50) })
  .meta({ id: "RegisterX402PayeeRequest" });

// ---------------------------------------------------------------- escrow & streams

export const EscrowStatus = z.enum([
  "requires_signature",
  "locking",
  "locked",
  "released",
  "refunded",
  "disputed",
  "resolved",
  "failed",
  "canceled",
]);

export const Escrow = z
  .object({
    id: idSchema("escrow"),
    object: z.literal("escrow"),
    payer_account_id: idSchema("account"),
    payee: Counterparty,
    amount: MoneySchema,
    fee: MoneySchema,
    status: EscrowStatus,
    release: z.enum(["payer", "arbiter", "validator"]),
    arbiter: AddressSchema.nullable(),
    validator: z
      .object({
        registry: AddressSchema,
        request_hash: Bytes32Schema,
        min_response: z.number().int().min(0).max(100),
      })
      .nullable(),
    terms_hash: Bytes32Schema.nullable(),
    contract_address: AddressSchema,
    onchain_id: z.string().nullable(),
    expires_at: TimestampSchema,
    signing_request: SigningRequest.nullable(),
    memo: z.string().nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .meta({ id: "Escrow" });

export const CreateEscrowRequest = z
  .object({
    account_id: idSchema("account"),
    payee: z
      .object({ address: AddressSchema.optional(), agent_id: idSchema("agent").optional() })
      .refine(
        (p) => [p.address, p.agent_id].filter(Boolean).length === 1,
        "set exactly one of payee.address, payee.agent_id",
      ),
    amount: MoneySchema,
    expires_at: TimestampSchema,
    release: z.enum(["payer", "arbiter", "validator"]).default("payer"),
    arbiter: AddressSchema.optional(),
    validator: z
      .object({
        registry: AddressSchema,
        request_hash: Bytes32Schema,
        min_response: z.number().int().min(0).max(100),
      })
      .optional(),
    terms: z
      .string()
      .max(10_000)
      .optional()
      .meta({ description: "Free-text terms; only their hash goes on-chain" }),
    memo: z.string().max(500).optional(),
    mandate_id: idSchema("mandate").optional(),
  })
  .meta({ id: "CreateEscrowRequest" });

export const DisputeEscrowRequest = z
  .object({ reason: z.string().min(1).max(2000) })
  .meta({ id: "DisputeEscrowRequest" });

export const StreamStatus = z.enum([
  "requires_signature",
  "active",
  "paused",
  "completed",
  "canceled",
  "failed",
]);

export const Stream = z
  .object({
    id: idSchema("stream"),
    object: z.literal("stream"),
    payer_account_id: idSchema("account"),
    payee: Counterparty,
    kind: z.enum(["streaming", "recurring"]),
    amount_per_interval: MoneySchema,
    interval_seconds: z.number().int().positive(),
    deposit: MoneySchema,
    settled: MoneySchema,
    settle_every_seconds: z.number().int().positive(),
    start_at: TimestampSchema,
    stop_at: TimestampSchema.nullable(),
    status: StreamStatus,
    contract_address: AddressSchema,
    onchain_id: z.string().nullable(),
    signing_request: SigningRequest.nullable(),
    created_at: TimestampSchema,
  })
  .meta({
    id: "Stream",
    description: "Pre-funded per-second stream or recurring payment, settled on an interval.",
  });

export const CreateStreamRequest = z
  .object({
    account_id: idSchema("account"),
    payee: z
      .object({ address: AddressSchema.optional(), agent_id: idSchema("agent").optional() })
      .refine(
        (p) => [p.address, p.agent_id].filter(Boolean).length === 1,
        "set exactly one of payee.address, payee.agent_id",
      ),
    kind: z.enum(["streaming", "recurring"]).default("streaming"),
    amount_per_interval: MoneySchema,
    interval_seconds: z.number().int().positive().meta({ description: "1 for per-second streaming" }),
    deposit: MoneySchema,
    settle_every_seconds: z.number().int().min(60).default(3600),
    start_at: TimestampSchema.optional(),
    stop_at: TimestampSchema.optional(),
    mandate_id: idSchema("mandate").optional(),
  })
  .meta({ id: "CreateStreamRequest" });

// ---------------------------------------------------------------- approvals

export const Approval = z
  .object({
    id: idSchema("approval"),
    object: z.literal("approval"),
    payment_id: idSchema("payment"),
    org_id: idSchema("org"),
    agent_id: idSchema("agent"),
    amount: MoneySchema,
    counterparty: Counterparty,
    required_approvers: z.number().int().min(1),
    decisions: z.array(
      z.object({
        member_id: idSchema("member"),
        decision: z.enum(["approve", "deny"]),
        decided_at: TimestampSchema,
      }),
    ),
    status: z.enum(["pending", "approved", "denied", "expired"]),
    expires_at: TimestampSchema,
    created_at: TimestampSchema,
  })
  .meta({ id: "Approval", description: "A payment waiting for human approval. Expires after 15 minutes." });

export const DecideApprovalRequest = z
  .object({
    decision: z.enum(["approve", "deny"]),
    webauthn_assertion: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: "Passkey assertion for the approval challenge (required for console members)" }),
  })
  .meta({ id: "DecideApprovalRequest" });

// ---------------------------------------------------------------- ledger

export const POCKETS = [
  "operating",
  "reserved",
  "fees",
  "savings",
  "escrow",
  "stream",
  "spend",
  "spend_reserved",
] as const;

export const LedgerLine = z
  .object({
    ledger_account: z.string().meta({ description: 'e.g. "pocket:operating" or "sys:revenue"' }),
    account_id: idSchema("account").nullable(),
    amount: SignedDecimalString,
    asset: AssetCodeSchema,
  })
  .meta({ id: "LedgerLine" });

export const LedgerEntry = z
  .object({
    id: idSchema("entry"),
    object: z.literal("ledger_entry"),
    ref_type: z.string(),
    ref_id: z.string().nullable(),
    memo: z.string().nullable(),
    payment_id: idSchema("payment").nullable(),
    agent_id: idSchema("agent").nullable(),
    mandate_id: idSchema("mandate").nullable(),
    decision_id: idSchema("decision").nullable(),
    reverses_entry_id: idSchema("entry").nullable(),
    lines: z.array(LedgerLine),
    created_at: TimestampSchema,
  })
  .meta({ id: "LedgerEntry", description: "An immutable, balanced journal entry." });

export const Statement = z
  .object({
    id: z.string(),
    object: z.literal("statement"),
    account_id: idSchema("account"),
    period: z.string().regex(/^[0-9]{4}-[0-9]{2}$/),
    asset: AssetCodeSchema,
    opening_balance: DecimalString,
    closing_balance: DecimalString,
    total_in: DecimalString,
    total_out: DecimalString,
    fees: DecimalString,
    entry_count: z.number().int().nonnegative(),
    lines: z.array(
      z.object({
        entry_id: idSchema("entry"),
        date: TimestampSchema,
        description: z.string(),
        amount: SignedDecimalString,
        balance: SignedDecimalString,
        ref_type: z.string(),
        ref_id: z.string().nullable(),
      }),
    ),
    generated_at: TimestampSchema,
  })
  .meta({ id: "Statement", description: "Monthly statement generated from the ledger." });

// ---------------------------------------------------------------- savings & treasury

export const Vault = z
  .object({
    id: idSchema("vault"),
    object: z.literal("vault"),
    account_id: idSchema("account"),
    kind: z.enum(["goal", "locked"]),
    name: z.string(),
    target: MoneySchema.nullable(),
    unlock_at: TimestampSchema.nullable(),
    balance: MoneySchema,
    contract_address: AddressSchema.nullable(),
    onchain_id: z.string().nullable(),
    created_at: TimestampSchema,
  })
  .meta({
    id: "Vault",
    description: "Goal vaults are ledger-only; locked vaults use the TimeLockVaults contract.",
  });

export const CreateVaultRequest = z
  .object({
    account_id: idSchema("account"),
    kind: z.enum(["goal", "locked"]),
    name: z.string().min(1).max(100),
    target: MoneySchema.optional(),
    unlock_at: TimestampSchema.optional(),
  })
  .meta({ id: "CreateVaultRequest" });

export const VaultTransferRequest = z
  .object({ amount: MoneySchema, owner_authorization: OwnerAuthorizationSchema.optional() })
  .meta({ id: "VaultTransferRequest" });

export const AutoTopUpRule = z
  .object({
    id: idSchema("topUpRule"),
    object: z.literal("auto_topup_rule"),
    agent_id: idSchema("agent"),
    treasury_account_id: idSchema("account"),
    refill_to: MoneySchema,
    when_below: MoneySchema,
    max_per_day: MoneySchema,
    status: z.enum(["active", "disabled"]),
    created_at: TimestampSchema,
  })
  .meta({
    id: "AutoTopUpRule",
    description: "Refill an agent from the org treasury when its balance drops.",
  });

export const PutAutoTopUpRequest = z
  .object({
    refill_to: MoneySchema,
    when_below: MoneySchema,
    max_per_day: MoneySchema,
    owner_authorization: OwnerAuthorizationSchema,
  })
  .meta({ id: "PutAutoTopUpRequest" });

export const Fund = z
  .object({
    id: idSchema("fund"),
    object: z.literal("fund"),
    name: z.string(),
    issuer: z.string(),
    token_address: AddressSchema,
    chain_id: z.number().int(),
    settlement: z.enum(["same_day", "next_day"]),
    eligibility: z.object({
      investor_types: z.array(z.string()),
      jurisdictions: z.string(),
      minimum: MoneySchema,
    }),
    disclosure: z.string(),
  })
  .meta({ id: "Fund", description: "Neutral eligibility list entry. Agent Bank makes no recommendation." });

export const SweepRule = z
  .object({
    id: idSchema("sweepRule"),
    object: z.literal("sweep_rule"),
    account_id: idSchema("account"),
    fund_id: idSchema("fund"),
    floor: MoneySchema,
    threshold: MoneySchema,
    max_share_bps: z.number().int().min(0).max(10_000),
    status: z.enum(["pending_install", "active", "disabled"]),
    install_operation_id: idSchema("ownerOperation").nullable(),
    created_at: TimestampSchema,
  })
  .meta({ id: "SweepRule" });

export const PutSweepRuleRequest = z
  .object({
    fund_id: idSchema("fund"),
    floor: MoneySchema.optional().meta({ description: "Default: two days of trailing seven-day spend" }),
    threshold: MoneySchema,
    max_share_bps: z.number().int().min(0).max(10_000),
    owner_authorization: OwnerAuthorizationSchema,
  })
  .meta({ id: "PutSweepRuleRequest" });

// ---------------------------------------------------------------- webhooks & events

export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export const WebhookEndpoint = z
  .object({
    id: idSchema("webhookEndpoint"),
    object: z.literal("webhook_endpoint"),
    url: z.url(),
    events: z.array(WebhookEventTypeSchema),
    status: z.enum(["enabled", "disabled"]),
    created_at: TimestampSchema,
  })
  .meta({ id: "WebhookEndpoint" });

export const WebhookEndpointWithSecret = WebhookEndpoint.extend({
  secret: z.string().meta({ description: "HMAC signing secret. Shown once." }),
}).meta({ id: "WebhookEndpointWithSecret" });

export const CreateWebhookEndpointRequest = z
  .object({ url: z.url(), events: z.array(WebhookEventTypeSchema).min(1) })
  .meta({ id: "CreateWebhookEndpointRequest" });

export const Event = z
  .object({
    id: idSchema("event"),
    object: z.literal("event"),
    type: WebhookEventTypeSchema,
    org_id: idSchema("org"),
    data: z.record(z.string(), z.unknown()),
    created_at: TimestampSchema,
  })
  .meta({ id: "Event" });

// ---------------------------------------------------------------- billing & revenue

export const Plan = z
  .object({
    code: OrgTier,
    name: z.string(),
    monthly_price: MoneySchema,
    max_agents: z.number().int().nullable(),
    features: z.array(z.string()),
  })
  .meta({ id: "Plan" });

export const Subscription = z
  .object({
    object: z.literal("subscription"),
    org_id: idSchema("org"),
    plan: Plan,
    status: z.enum(["active", "past_due", "canceled"]),
    current_period_start: TimestampSchema,
    current_period_end: TimestampSchema,
  })
  .meta({ id: "Subscription" });

export const ChangePlanRequest = z.object({ plan: OrgTier }).meta({ id: "ChangePlanRequest" });

export const FeeSummary = z
  .object({
    object: z.literal("fee_summary"),
    org_id: idSchema("org"),
    period: z.string(),
    by_kind: z.record(z.string(), DecimalString),
    total: DecimalString,
  })
  .meta({ id: "FeeSummary" });

export const RevenueReport = z
  .object({
    object: z.literal("revenue_report"),
    period: z.string(),
    revenue_by_stream: z.record(z.string(), DecimalString),
    total_revenue: DecimalString,
    variable_costs: DecimalString,
    gross_margin_bps: z.number().int(),
    volume_by_kind: z.record(z.string(), DecimalString),
    paying_orgs: z.record(OrgTier, z.number().int()),
    volume_per_org: DecimalString,
  })
  .meta({ id: "RevenueReport", description: "Revenue by stream, gross margin and volume per org." });

// ---------------------------------------------------------------- misc

export const Health = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.record(z.string(), z.string()),
});

export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: z.string(),
  })
  .loose()
  .meta({ id: "Problem", description: "RFC 9457 problem details" });

export const IdParam = (kind: Parameters<typeof idSchema>[0]) => z.object({ id: idSchema(kind) });
