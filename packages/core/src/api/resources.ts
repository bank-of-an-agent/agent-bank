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
    frozen_reason: z.string().nullable(),
    pending_unfreeze_at: TimestampSchema.nullable().meta({
      description: "When a pending owner-signed unfreeze takes effect",
    }),
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

export const RotateOwnerRequest = z
  .object({ new_owner_address: AddressSchema, owner_authorization: OwnerAuthorizationSchema })
  .meta({
    id: "RotateOwnerRequest",
    description:
      "Voluntary rotation signed by the current owner key (action owner.rotate). The on-chain Safe owner must be changed with an owner operation as well.",
  });

export const PrepareOwnerSwapRequest = z.object({ new_owner_address: AddressSchema }).meta({
  id: "PrepareOwnerSwapRequest",
  description:
    "Prepare the owner operation that swaps the Safe owner on one account (signed by the current owner key).",
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
    spend_key_permit: z
      .enum(["none", "pending", "executed"])
      .meta({ description: "Whether the float-recovery permit is on-chain yet" }),
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

export const SpendKeyPermit = z
  .object({
    value: z
      .string()
      .regex(/^[0-9]+$/)
      .meta({ description: "Allowance in USDC minor units (usually max uint256)" }),
    deadline: z.string().regex(/^[0-9]+$/),
    nonce: z
      .string()
      .regex(/^[0-9]+$/)
      .meta({ description: "USDC nonces(spend key) at signing time" }),
    signature: HexSchema,
  })
  .meta({
    id: "SpendKeyPermit",
    description:
      "EIP-2612 USDC permit signed by the spend key with spender = the agent's smart account, so the owner can always sweep the x402 float back (ADR 0001).",
  });

export const AttachSpendKeyRequest = z
  .object({
    spend_key_address: AddressSchema,
    permit: SpendKeyPermit,
    owner_authorization: OwnerAuthorizationSchema.meta({
      description: 'OwnerAuthorization with action "spend_key.set" over { account_id, spend_key_address }',
    }),
  })
  .meta({
    id: "AttachSpendKeyRequest",
    description:
      "Attach the agent's x402 spend key. The permit is executed on-chain in the account's next owner operation (normally the setup operation that installs the first session).",
  });

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
      "owner.swap",
    ]),
    subject_id: z
      .string()
      .meta({ description: "The session, payment, vault or rule this operation applies to" }),
    status: z.enum(["requires_signature", "submitted", "succeeded", "failed", "expired"]),
    user_op_hash: Bytes32Schema.meta({
      description: "Sign the raw 32 bytes of this hash with the owner key (EIP-191 personal sign)",
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
    revoke_operation_id: idSchema("ownerOperation")
      .nullable()
      .meta({ description: "Owner operation that revokes the session on-chain (the hard backstop)" }),
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
    contract: AddressSchema.optional().meta({
      description: "Contract the payment interacts with (escrow, streams), for session allowed_contracts",
    }),
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
      description: "Sign the raw 32 bytes of this hash with the session key (EIP-191 personal sign)",
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
    escrow_id: idSchema("escrow").nullable(),
    stream_id: idSchema("stream").nullable(),
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
    pending_action: z
      .enum(["lock", "release", "refund", "dispute"])
      .nullable()
      .meta({ description: "On-chain action waiting for the session signature, if any" }),
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
    pending_action: z
      .enum(["create", "cancel", "top_up"])
      .nullable()
      .meta({ description: "On-chain action waiting for the session signature, if any" }),
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
    decision: PolicyDecisionSchema.nullable().meta({
      description: "The policy decision that required approval (rule hits)",
    }),
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
    pending_operation_id: idSchema("ownerOperation").nullable(),
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
    status: z.enum(["pending_install", "active", "disabled"]),
    install_operation_id: idSchema("ownerOperation").nullable(),
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

// ---------------------------------------------------------------- private proofs

/**
 * The 13 attested attributes of schema `agentbank.claims.v1`, in circuit order. Every value is
 * an integer below 2^64 (money in USDC minor units, times in unix seconds).
 */
export const PROOF_ATTRIBUTES = [
  "principal_verification",
  "per_tx_limit",
  "per_day_limit",
  "balance",
  "reserved_amount",
  "reserved_until",
  "reserved_for",
  "account_created_on",
  "payments_settled",
  "volume_settled",
  "escrows_completed",
  "disputes_lost",
  "counterparties",
] as const;

/** What an owner may let an agent prove; each class covers one or more attributes. */
export const DISCLOSURE_CLASSES = [
  "principal",
  "limits",
  "balance",
  "reservations",
  "account_age",
  "reputation",
] as const;

/** Why a presentation was refused, in the order the checks run. */
export const PROOF_FAILURE_REASONS = [
  "malformed",
  "request_expired",
  "nonce_invalid",
  "nonce_reused",
  "request_hash_mismatch",
  "unknown_root",
  "root_revoked",
  "root_expired",
  "root_too_old",
  "anonymity_set_too_small",
  "invalid_proof",
] as const;

export const PROOF_ROOT_STATUSES = ["publishing", "published", "revoked", "expired", "failed"] as const;

export const DisclosureClass = z.enum(DISCLOSURE_CLASSES).meta({
  id: "DisclosureClass",
  description:
    "principal: principal_verification. limits: per_tx_limit, per_day_limit. balance: balance. reservations: reserved_amount, reserved_until, reserved_for. account_age: account_created_on. reputation: payments_settled, volume_settled, escrows_completed, disputes_lost, counterparties.",
});

export const ProofAttribute = z.enum(PROOF_ATTRIBUTES).meta({
  id: "ProofAttribute",
  description: "An attested attribute of schema agentbank.claims.v1 (listed in circuit order).",
});

export const ProofFailureReason = z.enum(PROOF_FAILURE_REASONS).meta({ id: "ProofFailureReason" });

export const ProofRootStatus = z.enum(PROOF_ROOT_STATUSES).meta({
  id: "ProofRootStatus",
  description: "publishing → published → (revoked | expired), or failed.",
});

/** Base-10 unsigned integer string (u64 values, epochs). */
const UintString = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "must be a base-10 integer string");

/** A BN254 field element (Groth16 proof coordinate) as a base-10 string. */
const FieldDecimal = z.string().regex(/^(0|[1-9][0-9]{0,76})$/, "must be a base-10 field element");

const HexId = (bytes: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `must be ${bytes} bytes of lowercase hex`);

export const ProofBound = z
  .object({
    min: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,6})?$/)
      .optional()
      .meta({ description: "Inclusive lower bound. Omitted: 0." }),
    max: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,6})?$/)
      .optional()
      .meta({ description: "Inclusive upper bound. Omitted: 2^64 - 1." }),
  })
  .strict()
  .meta({
    id: "ProofBound",
    description:
      'Inclusive [min, max] bound on one attribute. Money attributes (per_tx_limit, per_day_limit, balance, reserved_amount, volume_settled) take decimal USDC strings ("5.00"); every other attribute takes base-10 integer strings (unix seconds for reserved_until and account_created_on). Equality is min = max.',
  });

export const ProofRequest = z
  .object({
    type: z.literal("agentbank.proof_request.v1"),
    scope: z
      .string()
      .min(1)
      .max(253)
      .meta({ description: "The verifier's identifier, normally its host name (at most 253 characters)" }),
    request_id: HexId(16).meta({ description: "16 random bytes, lowercase hex" }),
    nonce: z
      .string()
      .regex(/^0x[0-9a-f]{62}$/, "must be 31 bytes of 0x-prefixed lowercase hex")
      .meta({
        description:
          "31-byte challenge bound into the proof. Stateless gates derive it as the first 31 bytes of HMAC-SHA256(gate key, canonical JSON of the request without nonce).",
      }),
    issued_at: z.number().int().nonnegative().meta({ description: "Unix seconds" }),
    expires_at: z.number().int().positive().meta({ description: "Unix seconds" }),
    constraints: z
      .partialRecord(ProofAttribute, ProofBound)
      .meta({ description: "Bounds per attribute; omitted attributes are unconstrained." }),
    max_root_age_seconds: z
      .number()
      .int()
      .positive()
      .meta({ description: "Oldest snapshot accepted, in seconds before verification" }),
    min_anonymity_set: z
      .number()
      .int()
      .min(1)
      .meta({ description: "Fewest leaves the proof's root must have" }),
    chain_id: z.number().int().positive(),
    registry: AddressSchema.nullable().meta({
      description: "AgentAttestationRegistry the root must be published in (null: the deployment's)",
    }),
  })
  .strict()
  .refine((r) => r.expires_at > r.issued_at, { message: "expires_at must be after issued_at" })
  .meta({
    id: "ProofRequest",
    description:
      "A verifier's proof request (sent base64 JSON in AGENT-PROOF-REQUIRED). request_hash = keccak256 of its canonical JSON.",
  });

export const Groth16Proof = z
  .object({
    pi_a: z.tuple([FieldDecimal, FieldDecimal, FieldDecimal]),
    pi_b: z.tuple([
      z.tuple([FieldDecimal, FieldDecimal]),
      z.tuple([FieldDecimal, FieldDecimal]),
      z.tuple([FieldDecimal, FieldDecimal]),
    ]),
    pi_c: z.tuple([FieldDecimal, FieldDecimal, FieldDecimal]),
    protocol: z.literal("groth16"),
    curve: z.literal("bn128"),
  })
  .strict()
  .meta({ id: "Groth16Proof", description: "A Groth16 proof on BN254 in snarkjs JSON form." });

export const ProofPresentation = z
  .object({
    type: z.literal("agentbank.proof.v1"),
    request_hash: Bytes32Schema.meta({ description: "keccak256 of the request's canonical JSON" }),
    root: Bytes32Schema.meta({ description: "The published tree root the proof is against" }),
    nullifier: Bytes32Schema.meta({
      description: "Poseidon(secret, scope): a per-verifier pseudonym, unlinkable across verifiers",
    }),
    proof: Groth16Proof,
  })
  .strict()
  .meta({
    id: "ProofPresentation",
    description:
      "An agent's answer to a proof request. Verifiers rebuild the public signals from their own request, never from the agent.",
  });

export const ProofCircuit = z
  .object({
    object: z.literal("proof_circuit"),
    schema: z.literal("agentbank.claims.v1"),
    protocol: z.literal("groth16"),
    curve: z.literal("bn128"),
    tree_depth: z.number().int().positive(),
    attributes: z.array(ProofAttribute),
    disclosure_classes: z
      .record(DisclosureClass, z.array(ProofAttribute))
      .meta({ description: "The attributes each disclosure class covers" }),
    public_signals: z.array(z.string()).meta({ description: "Public signal layout, in circuit order" }),
    constraints: z.number().int().positive(),
    verification_key: z.record(z.string(), z.unknown()).meta({ description: "snarkjs verification key" }),
    sha256: z
      .record(z.string(), z.string().regex(/^[0-9a-f]{64}$/))
      .meta({ description: "SHA-256 of each circuit artifact, from the circuit manifest" }),
    chain_id: z.number().int(),
    registry: AddressSchema.nullable().meta({ description: "AgentAttestationRegistry on this chain" }),
    verifier: AddressSchema.nullable().meta({ description: "AgentClaimsVerifier on this chain" }),
  })
  .meta({
    id: "ProofCircuit",
    description: "The claims circuit, its verification key and where its roots are published.",
  });

export const ProofRoot = z
  .object({
    object: z.literal("proof_root"),
    root: Bytes32Schema,
    epoch: UintString.meta({ description: "Strictly increasing snapshot number" }),
    snapshot_at: TimestampSchema.meta({ description: "When the attested facts were read" }),
    published_at: TimestampSchema.nullable().meta({ description: "Block time of publication" }),
    valid_until: TimestampSchema.meta({ description: "Proofs against this root are refused after it" }),
    leaf_count: z.number().int().nonnegative().meta({ description: "The anonymity set of proofs" }),
    status: ProofRootStatus,
    tx_hash: Bytes32Schema.nullable(),
    chain_id: z.number().int(),
    registry: AddressSchema.nullable(),
  })
  .meta({ id: "ProofRoot", description: "A Merkle root of attested facts anchored on Base." });

export const ProofSettings = z
  .object({
    object: z.literal("proof_settings"),
    agent_id: idSchema("agent"),
    enabled: z.boolean().meta({ description: "Whether the agent appears in the attested tree at all" }),
    disclose: z.array(DisclosureClass).meta({ description: "Classes a proof may constrain" }),
    disclosure_mask: z
      .number()
      .int()
      .min(0)
      .max(8191)
      .meta({ description: "13-bit mask (bit i: attribute i may be constrained), hashed into the leaf" }),
    updated_at: TimestampSchema.nullable().meta({
      description: "Null until the owner first configures proofs",
    }),
  })
  .meta({
    id: "ProofSettings",
    description: "What an agent may prove about itself. Disclosure is the owner's decision.",
  });

export const UpdateProofSettingsRequest = z
  .object({
    enabled: z.boolean(),
    disclose: z
      .array(DisclosureClass)
      .max(DISCLOSURE_CLASSES.length)
      .refine((classes) => new Set(classes).size === classes.length, "disclosure classes must be unique"),
    owner_authorization: OwnerAuthorizationSchema.optional().meta({
      description:
        'Required when the change widens disclosure (enables proofs or adds a class): action "proofs.disclose" over { agent_id, enabled, disclose (sorted) }. Narrowing needs only an API key and revokes older roots at once.',
    }),
  })
  .meta({ id: "UpdateProofSettingsRequest" });

export const ProofIdentity = z
  .object({
    object: z.literal("proof_identity"),
    account_id: idSchema("account"),
    identity_commitment: Bytes32Schema.meta({
      description:
        "Poseidon(secret) as a 32-byte big-endian field element; the secret never leaves the agent",
    }),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .meta({ id: "ProofIdentity", description: "The agent's enrolled identity commitment." });

export const EnrollProofIdentityRequest = z
  .object({
    identity_commitment: Bytes32Schema.meta({
      description: "Poseidon(secret), a non-zero BN254 field element as 32-byte hex",
    }),
  })
  .meta({ id: "EnrollProofIdentityRequest" });

export const ProofWitness = z
  .object({
    object: z.literal("proof_witness"),
    schema: z.literal("agentbank.claims.v1"),
    account_id: idSchema("account"),
    chain_id: z.number().int(),
    registry: AddressSchema.nullable(),
    root: Bytes32Schema,
    epoch: UintString,
    snapshot_at: TimestampSchema,
    valid_until: TimestampSchema,
    leaf_count: z.number().int().positive(),
    leaf_index: z.number().int().nonnegative(),
    siblings: z.array(FieldDecimal).length(20).meta({ description: "Merkle path, leaf level first" }),
    path_bits: z
      .array(z.union([z.literal(0), z.literal(1)]))
      .length(20)
      .meta({ description: "1 when the node at that level is a right child" }),
    attributes: z.record(ProofAttribute, UintString).meta({
      description: "Attested values as base-10 integers in raw units (USDC minor units, unix seconds)",
    }),
    disclosure_mask: z.number().int().min(0).max(8191),
    reservation_id: idSchema("proofReservation")
      .nullable()
      .meta({ description: "The reservation this leaf represents; null for the base leaf" }),
  })
  .meta({
    id: "ProofWitness",
    description:
      "Everything an agent needs, besides its secret, to prove against a published root: its leaf's attested values and Merkle path.",
  });

export const ProofReservationStatus = z.enum(["pending", "active", "released", "expired"]);

export const ProofReservation = z
  .object({
    id: idSchema("proofReservation"),
    object: z.literal("proof_reservation"),
    account_id: idSchema("account"),
    agent_id: idSchema("agent"),
    amount: MoneySchema,
    scope_tag: UintString.meta({ description: "Low 64 bits of the verifier's scope (reserved_for)" }),
    expires_at: TimestampSchema,
    status: ProofReservationStatus.meta({
      description: "pending until a root includes it, active while provable, then released or expired",
    }),
    hold_id: idSchema("hold"),
    created_at: TimestampSchema,
    released_at: TimestampSchema.nullable(),
    included_in_epoch: UintString.nullable().meta({ description: "First root epoch whose tree includes it" }),
  })
  .meta({
    id: "ProofReservation",
    description:
      "Funds held for one verifier so the agent can prove '$X is reserved for you until T'. The agent cannot spend them through Agent Bank or cancel the reservation; only the owner can release it early.",
  });

export const CreateProofReservationRequest = z
  .object({
    amount: MoneySchema,
    scope: z.string().min(1).max(253).optional().meta({ description: "The verifier's scope identifier" }),
    scope_tag: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((tag) => BigInt(tag) <= 18_446_744_073_709_551_615n, "must be below 2^64")
      .optional()
      .meta({ description: "Or just the verifier's 64-bit scope tag, as a base-10 string" }),
    expires_at: TimestampSchema.meta({ description: "When the hold is released; at most 7 days ahead" }),
  })
  .refine((r) => (r.scope === undefined) !== (r.scope_tag === undefined), {
    message: "set exactly one of scope, scope_tag",
  })
  .meta({ id: "CreateProofReservationRequest" });

export const ReleaseProofReservationRequest = z
  .object({
    owner_authorization: OwnerAuthorizationSchema.meta({
      description: 'OwnerAuthorization with action "proofs.reservation.release" over { reservation_id }',
    }),
  })
  .meta({ id: "ReleaseProofReservationRequest" });

export const VerifyProofRequest = z
  .object({ request: ProofRequest, presentation: ProofPresentation })
  .meta({ id: "VerifyProofRequest" });

export const VerifyProofResponse = z
  .object({
    object: z.literal("proof_verification"),
    valid: z.boolean(),
    reason: ProofFailureReason.nullable().meta({ description: "Why the presentation was refused" }),
    nullifier: Bytes32Schema.nullable().meta({
      description: "The agent's pseudonym for this scope, when valid",
    }),
    root: Bytes32Schema.nullable(),
    root_status: ProofRootStatus.nullable(),
  })
  .meta({
    id: "VerifyProofResponse",
    description:
      "Result of checking a presentation against a request (expiry, request hash, root, proof). Nonce freshness is the verifier's own concern.",
  });

// ---------------------------------------------------------------- meta

export const Meta = z
  .object({
    object: z.literal("meta"),
    api_version: z.string(),
    chain: ChainNameSchema,
    chain_id: z.number().int(),
    caip2: z.string(),
    owner_authorization_chain_id: z
      .number()
      .int()
      .meta({ description: "EIP-712 domain chain id to use for OwnerAuthorization signatures" }),
    usdc: z.object({
      address: AddressSchema,
      decimals: z.number().int(),
      eip712_name: z.string(),
      eip712_version: z.string(),
    }),
    contracts: z
      .record(z.string(), AddressSchema)
      .meta({ description: "Agent Bank contract addresses on this chain" }),
    cosigner_address: AddressSchema.nullable(),
    revenue_address: AddressSchema.nullable(),
    facilitator_url: z.string().nullable(),
    features: z.record(z.string(), z.boolean()),
  })
  .meta({
    id: "Meta",
    description: "Deployment facts clients need: chain, USDC, contract addresses, feature flags.",
  });

// ---------------------------------------------------------------- sandbox

export const SandboxFaucetRequest = z
  .object({
    account_id: idSchema("account").optional(),
    address: AddressSchema.optional(),
    amount: MoneySchema,
  })
  .refine(
    (r) => [r.account_id, r.address].filter(Boolean).length === 1,
    "set exactly one of account_id, address",
  )
  .meta({ id: "SandboxFaucetRequest" });

export const SandboxFaucetResponse = z
  .object({
    object: z.literal("faucet_transfer"),
    address: AddressSchema,
    amount: MoneySchema,
    tx_hash: Bytes32Schema.nullable(),
  })
  .meta({
    id: "SandboxFaucetResponse",
    description:
      "Test USDC minted on the simulated chain or Anvil. Unavailable on Base Sepolia (use Circle's faucet).",
  });

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
