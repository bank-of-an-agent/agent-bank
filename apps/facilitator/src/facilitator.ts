import type { ChainGateway } from "@agentbank/chain";
import {
  AgentBankError,
  assertTestnet,
  formatAmount,
  systemClock,
  unixSeconds,
  type AssetInfo,
  type ChainInfo,
  type Clock,
} from "@agentbank/core";
import type { ResponseOf } from "@agentbank/core/api";
import type { SqlClient } from "@agentbank/db";
import { BaseError, isAddressEqual, size, slice, type Address, type Hex, type LocalAccount } from "viem";
import { contractSignatureVerifierFor, type ContractSignatureVerifier } from "./erc1271";
import type { RelayerGasGuard } from "./gas";
import type { Metrics, SettleOutcome, VerifyOutcome } from "./metrics";
import { isInfrastructureReason, reject, type Rejection } from "./reasons";
import type { ReceiptSource } from "./receipts";
import { isBlocked, screenOrFail, type ScreeningProvider, type ScreeningResult } from "./screening";
import { AuthorizationStore, type AuthorizationKey, type AuthorizationRow } from "./store";
import {
  authorizationDigest,
  checkTerms,
  classifySignature,
  normalizeEcdsaSignature,
  parsePayment,
  parseRequestBody,
  recoverEcdsaSigner,
  requestFingerprint,
  type ParsedPayment,
  type ServedChain,
} from "./verification";

export type VerifyResponse = ResponseOf<"x402Verify">;
export type SettleResponse = ResponseOf<"x402Settle">;
export type SupportedResponse = ResponseOf<"x402Supported">;

/** An HTTP answer: status plus a body in the x402 response shape (and extra headers, e.g. Retry-After). */
export interface FacilitatorReply<T> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

export interface FacilitatorLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const silentLogger: FacilitatorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface FacilitatorOptions {
  /** The single network this facilitator serves (Base Sepolia; Anvil or the simulator in dev). */
  chain: ChainInfo;
  /** USDC on `chain`. */
  asset: AssetInfo;
  /**
   * Payments strictly above this many atomic units should be settled before the resource is
   * served. Enforced by the seller middleware; published in `/supported`. Default $1.00.
   */
  settleBeforeServeAbove?: bigint;
  /** Optional global cap on one settlement (atomic units). */
  maxSettlement?: bigint | undefined;
  /** How long settle waits for the receipt before answering `settlement_pending`. Default 20 s. */
  receiptTimeoutMs?: number;
  /** Screening timeout per address. Default 5 s. */
  screeningTimeoutMs?: number;
  /**
   * Seconds after `validBefore` after which an unconfirmed `settling` row whose nonce is unused
   * on-chain is marked failed (it can no longer settle). Default 120.
   */
  expiryGraceSeconds?: number;
  /**
   * `any` (sandbox default): any `payTo`. `registered`: only addresses of Agent Bank accounts
   * registered in `x402_payee` on the served chain (`payee_not_registered` otherwise).
   */
  payeeMode?: PayeeMode;
  /** Settle requests this process handles at once; more are refused (`facilitator_busy`). Default 16. */
  maxInflightSettlements?: number;
}

export type PayeeMode = "any" | "registered";

export interface FacilitatorDeps {
  db: SqlClient;
  gateway: ChainGateway;
  receipts: ReceiptSource;
  screening: ScreeningProvider;
  clock?: Clock;
  /** Relayer that pays gas for `transferWithAuthorization` (testnet key). Required by the EVM gateway. */
  relayer?: LocalAccount | undefined;
  /**
   * ERC-1271 check for payers with code, with FiatToken's exact rule (default: a direct
   * `isValidSignature` call on JSON-RPC gateways, `verifySignature` on the simulator).
   */
  contractSignatures?: ContractSignatureVerifier | undefined;
  /** Refuses settlements while the relayer's gas balance is below the minimum (EVM chains). */
  relayerGas?: RelayerGasGuard | undefined;
  metrics?: Metrics | undefined;
  logger?: FacilitatorLogger | undefined;
  options: FacilitatorOptions;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<string, string>;
  httpStatus: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; rejection: Rejection };

interface SettleResult {
  outcome: SettleOutcome;
  reason?: string | undefined;
  reply: FacilitatorReply<SettleResponse>;
  payment?: ParsedPayment | undefined;
}

const DEFAULT_SETTLE_BEFORE_SERVE_ABOVE = 1_000_000n; // $1.00
const DEFAULT_RECEIPT_TIMEOUT_MS = 20_000;
const DEFAULT_EXPIRY_GRACE_SECONDS = 120;
const DEFAULT_MAX_INFLIGHT_SETTLEMENTS = 16;
/** Longest log range scanned to find how an authorization was used on-chain. */
const MAX_LOOKBACK_BLOCKS = 5_000n;

/** Error text safe for logs and the database: viem's short message, hex blobs (calldata, signatures) cut. */
export function safeErrorMessage(error: unknown): string {
  let message: string;
  if (error instanceof AgentBankError) message = `${error.code}: ${error.message}`;
  else if (error instanceof BaseError) message = error.shortMessage;
  else if (error instanceof Error) message = error.message;
  else message = String(error);
  return message.replace(/0x[0-9a-fA-F]{130,}/g, "0x[redacted]").slice(0, 500);
}

function revertDetail(error: unknown): string {
  if (error instanceof AgentBankError && typeof error.extensions.revertReason === "string") {
    return error.extensions.revertReason.replace(/0x[0-9a-fA-F]{130,}/g, "0x[redacted]").slice(0, 500);
  }
  return safeErrorMessage(error);
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(rejection: Rejection): Result<T> {
  return { ok: false, rejection };
}

function networkOf(body: unknown, fallback: string): string {
  const network = (body as { paymentRequirements?: { network?: unknown } } | null)?.paymentRequirements
    ?.network;
  return typeof network === "string" && network.length > 0 && network.length <= 64 ? network : fallback;
}

function invalidReply(rejection: Rejection): FacilitatorReply<VerifyResponse> {
  return {
    status: rejection.status,
    body: {
      isValid: false,
      invalidReason: rejection.reason,
      invalidMessage: rejection.message,
      ...(rejection.payer !== undefined ? { payer: rejection.payer } : {}),
    },
  };
}

function settleFailureReply(
  rejection: Rejection,
  network: string,
  transaction?: string | null,
): FacilitatorReply<SettleResponse> {
  return {
    status: rejection.status,
    body: {
      success: false,
      errorReason: rejection.reason,
      errorMessage: rejection.message,
      ...(rejection.payer !== undefined ? { payer: rejection.payer } : {}),
      transaction: transaction ?? "",
      network,
    },
  };
}

/**
 * The x402 facilitator for the `exact` EVM scheme (EIP-3009 `transferWithAuthorization`).
 *
 * `verify` answers whether a payment would settle now; `settle` re-runs every check, claims
 * the authorization in the single-use log (`x402_authorization`) before anything is
 * submitted, relays `transferWithAuthorization` with the testnet relayer and waits for the
 * receipt. A repeated identical settle is answered from the log (the original transaction);
 * a concurrent one is refused with `settlement_in_progress`. Every external dependency fails
 * closed: database, chain RPC or screening errors refuse the payment with an HTTP 5xx.
 */
export class Facilitator {
  readonly chain: ChainInfo;
  readonly asset: AssetInfo;
  readonly settleBeforeServeAbove: bigint;
  readonly maxSettlement: bigint | undefined;
  readonly relayerAddress: Address | undefined;
  readonly payeeMode: PayeeMode;
  readonly maxInflightSettlements: number;

  readonly #served: ServedChain;
  readonly #store: AuthorizationStore;
  readonly #gateway: ChainGateway;
  readonly #receipts: ReceiptSource;
  readonly #contractSignatures: ContractSignatureVerifier;
  readonly #screening: ScreeningProvider;
  readonly #clock: Clock;
  readonly #relayer: LocalAccount | undefined;
  readonly #metrics: Metrics | undefined;
  readonly #log: FacilitatorLogger;
  readonly #receiptTimeoutMs: number;
  readonly #screeningTimeoutMs: number;
  readonly #expiryGraceSeconds: number;
  readonly #relayerGas: RelayerGasGuard | undefined;
  #inflight = 0;

  constructor(deps: FacilitatorDeps) {
    const { chain, asset } = deps.options;
    assertTestnet(chain.id);
    if (deps.gateway.chainId !== chain.id) {
      throw new Error(
        `The chain gateway serves chain ${deps.gateway.chainId}, the facilitator is configured for ${chain.id}`,
      );
    }
    if (asset.chainId !== chain.id || asset.code !== "USDC") {
      throw new Error(`The settlement asset must be USDC on chain ${chain.id}`);
    }
    if (!isAddressEqual(asset.address, deps.gateway.contracts.usdc)) {
      throw new Error(`USDC ${asset.address} is not the gateway's USDC ${deps.gateway.contracts.usdc}`);
    }
    this.chain = chain;
    this.asset = asset;
    this.settleBeforeServeAbove = deps.options.settleBeforeServeAbove ?? DEFAULT_SETTLE_BEFORE_SERVE_ABOVE;
    this.maxSettlement = deps.options.maxSettlement;
    this.relayerAddress = deps.relayer?.address;
    this.#served = { chain, asset };
    this.#store = new AuthorizationStore(deps.db);
    this.#gateway = deps.gateway;
    this.#receipts = deps.receipts;
    this.#contractSignatures = deps.contractSignatures ?? contractSignatureVerifierFor(deps.gateway);
    this.#screening = deps.screening;
    this.#clock = deps.clock ?? systemClock;
    this.#relayer = deps.relayer;
    this.#metrics = deps.metrics;
    this.#log = deps.logger ?? silentLogger;
    this.#receiptTimeoutMs = deps.options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.#screeningTimeoutMs = deps.options.screeningTimeoutMs ?? 5_000;
    this.#expiryGraceSeconds = deps.options.expiryGraceSeconds ?? DEFAULT_EXPIRY_GRACE_SECONDS;
    this.payeeMode = deps.options.payeeMode ?? "any";
    this.maxInflightSettlements = deps.options.maxInflightSettlements ?? DEFAULT_MAX_INFLIGHT_SETTLEMENTS;
    if (!Number.isInteger(this.maxInflightSettlements) || this.maxInflightSettlements < 1) {
      throw new RangeError("maxInflightSettlements must be a positive integer");
    }
    this.#relayerGas = deps.relayerGas;
  }

  /** Settle requests in flight in this process. */
  get inflightSettlements(): number {
    return this.#inflight;
  }

  // ------------------------------------------------------------------------------- supported

  /** `GET /supported`: the exact scheme on the served network, with settlement hints in `extra`. */
  supported(): SupportedResponse {
    const decimals = this.asset.decimals;
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: this.chain.caip2,
          extra: {
            asset: this.asset.address,
            name: this.asset.eip712.name,
            version: this.asset.eip712.version,
            decimals,
            settleBeforeServeAbove: formatAmount(this.settleBeforeServeAbove, decimals),
            ...(this.maxSettlement !== undefined
              ? { maxSettlement: formatAmount(this.maxSettlement, decimals) }
              : {}),
          },
        },
      ],
      extensions: [],
      signers: this.relayerAddress ? { "eip155:*": [this.relayerAddress] } : {},
    };
  }

  // ------------------------------------------------------------------------------- verify

  /** `POST /verify`: would this payment settle now? Read-only. */
  async verify(body: unknown): Promise<FacilitatorReply<VerifyResponse>> {
    const started = performance.now();
    let reply: FacilitatorReply<VerifyResponse>;
    let outcome: VerifyOutcome;
    let reason: string | undefined;
    let payment: ParsedPayment | undefined;
    try {
      const result = await this.#verify(body);
      if (result.ok) {
        payment = result.value;
        reply = { status: 200, body: { isValid: true, payer: payment.payer } };
        outcome = "valid";
      } else {
        reply = invalidReply(result.rejection);
        reason = result.rejection.reason;
        outcome = isInfrastructureReason(result.rejection.reason) ? "error" : "invalid";
      }
    } catch (error) {
      this.#log.error(
        { event: "x402.verify", err: safeErrorMessage(error) },
        "x402 verify failed unexpectedly",
      );
      const rejection = reject("unexpected_verify_error");
      reply = invalidReply(rejection);
      reason = rejection.reason;
      outcome = "error";
    }
    const seconds = (performance.now() - started) / 1000;
    this.#metrics?.observeVerify(outcome, reason, seconds);
    this.#log.info(
      {
        event: "x402.verify",
        outcome,
        reason,
        payer: reply.body.payer,
        ...(payment ? this.#describe(payment) : {}),
        ms: Math.round(seconds * 1000),
      },
      outcome === "valid" ? "x402 payment verified" : "x402 payment refused",
    );
    return reply;
  }

  async #verify(body: unknown): Promise<Result<ParsedPayment>> {
    const request = parseRequestBody(body);
    if (!request.ok) return request;
    const parsed = parsePayment(request.value, this.#served);
    if (!parsed.ok) return parsed;
    const payment = parsed.value;
    const terms = checkTerms(payment, this.#terms());
    if (terms) return fail(terms);
    if (this.payeeMode === "registered") {
      const payee = await this.#payee(payment);
      if (!payee.ok) return payee;
    }
    // "Valid" means "would settle now": not while the relayer cannot pay for it.
    const gas = await this.#gas();
    if (gas) return fail(gas);
    const checked = await this.#checkAuthorization(payment, { checkLog: true });
    return checked.ok ? ok(payment) : checked;
  }

  // ------------------------------------------------------------------------------- settle

  /** `POST /settle`: verify again, claim the authorization, relay it and wait for the receipt. */
  async settle(body: unknown): Promise<FacilitatorReply<SettleResponse>> {
    const started = performance.now();
    if (this.#inflight >= this.maxInflightSettlements) {
      // Load shedding: every settle holds a relay and a receipt wait; refuse before doing any work.
      const rejection = reject(
        "facilitator_busy",
        `${this.#inflight} settlements are in flight (limit ${this.maxInflightSettlements}); retry shortly`,
      );
      this.#metrics?.observeSettle("error", rejection.reason, (performance.now() - started) / 1000);
      this.#log.warn(
        { event: "x402.settle", outcome: "busy", inflight: this.#inflight },
        "x402 settlement refused: busy",
      );
      return {
        ...settleFailureReply(rejection, networkOf(body, this.chain.caip2)),
        headers: { "retry-after": "1" },
      };
    }
    this.#inflight += 1;
    try {
      return await this.#settleObserved(body, started);
    } finally {
      this.#inflight -= 1;
    }
  }

  async #settleObserved(body: unknown, started: number): Promise<FacilitatorReply<SettleResponse>> {
    let result: SettleResult;
    try {
      result = await this.#settle(body);
    } catch (error) {
      this.#log.error(
        { event: "x402.settle", err: safeErrorMessage(error) },
        "x402 settle failed unexpectedly",
      );
      const rejection = reject("unexpected_settle_error");
      result = {
        outcome: "error",
        reason: rejection.reason,
        reply: settleFailureReply(rejection, networkOf(body, this.chain.caip2)),
      };
    }
    const seconds = (performance.now() - started) / 1000;
    this.#metrics?.observeSettle(result.outcome, result.reason, seconds);
    const level =
      result.outcome === "failed" || result.outcome === "pending" || result.outcome === "error"
        ? "warn"
        : "info";
    this.#log[level](
      {
        event: "x402.settle",
        outcome: result.outcome,
        reason: result.reason,
        payer: result.reply.body.payer,
        transaction: result.reply.body.transaction || undefined,
        ...(result.payment ? this.#describe(result.payment) : {}),
        ms: Math.round(seconds * 1000),
      },
      `x402 settlement ${result.outcome}`,
    );
    return result.reply;
  }

  async #settle(body: unknown): Promise<SettleResult> {
    const fallbackNetwork = networkOf(body, this.chain.caip2);
    const request = parseRequestBody(body);
    if (!request.ok) return this.#refused(request.rejection, fallbackNetwork);
    const parsed = parsePayment(request.value, this.#served);
    if (!parsed.ok) return this.#refused(parsed.rejection, fallbackNetwork);
    const payment = parsed.value;
    const fingerprint = requestFingerprint(payment);
    const key = this.#key(payment);

    // An earlier attempt for this authorization decides the answer (idempotency, single use),
    // before anything time-dependent is re-checked.
    const existing = await this.#db("find authorization", () => this.#store.findByKey(key));
    if (!existing.ok) return this.#refused(existing.rejection, payment.network, payment);
    if (existing.value) return this.#answerFromLog(existing.value, payment, fingerprint);

    const terms = checkTerms(payment, this.#terms());
    if (terms) return this.#refused(terms, payment.network, payment);
    const payee = await this.#payee(payment);
    if (!payee.ok) return this.#refused(payee.rejection, payment.network, payment);
    const gas = await this.#gas();
    if (gas) return this.#refused(gas, payment.network, payment);
    const checked = await this.#checkAuthorization(payment, { checkLog: false });
    if (!checked.ok) return this.#refused(checked.rejection, payment.network, payment);

    // Claim the authorization BEFORE submitting: UNIQUE (chain_id, asset, authorizer, nonce)
    // lets exactly one request (on any replica) proceed to the chain.
    const claimed = await this.#db("claim authorization", () =>
      this.#store.insertSettling({
        ...key,
        payTo: payment.payTo,
        amount: payment.amount,
        validAfter: payment.authorization.validAfter,
        validBefore: payment.authorization.validBefore,
        payeeAccountId: payee.value,
        resourceUrl: payment.resourceUrl,
        requestHash: fingerprint,
        relayer: this.relayerAddress,
        at: this.#clock.now(),
      }),
    );
    if (!claimed.ok) return this.#refused(claimed.rejection, payment.network, payment);
    if (!claimed.value) {
      const winner = await this.#db("find authorization", () => this.#store.findByKey(key));
      const differs = winner.ok && winner.value !== undefined && winner.value.request_hash !== fingerprint;
      return this.#refused(
        differs
          ? reject(
              "authorization_already_used",
              "This authorization was already submitted with a different request",
              payment.payer,
            )
          : reject("settlement_in_progress", undefined, payment.payer),
        payment.network,
        payment,
      );
    }
    return this.#submit(claimed.value, payment, checked.value);
  }

  /** Answer a settle request for an authorization that is already in the log. */
  async #answerFromLog(
    row: AuthorizationRow,
    payment: ParsedPayment,
    fingerprint: string,
  ): Promise<SettleResult> {
    if (row.request_hash !== fingerprint) {
      return this.#refused(
        reject(
          "authorization_already_used",
          `This authorization was already submitted for settlement with a different request (status: ${row.status})`,
          payment.payer,
        ),
        payment.network,
        payment,
      );
    }
    const current = row.status === "settling" ? await this.#resolveSettling(row) : row;
    if (current.status === "settled" && current.tx_hash) {
      return { outcome: "replayed", reply: this.#successReply(payment, current.tx_hash), payment };
    }
    if (current.status === "failed") {
      const reason = (current.failure_reason ?? "invalid_transaction_state") as Rejection["reason"];
      const rejection = reject(
        reason,
        current.failure_detail ?? "The settlement of this authorization failed",
        payment.payer,
      );
      return {
        outcome: "rejected",
        reason,
        reply: settleFailureReply({ ...rejection, status: 200 }, payment.network, current.tx_hash),
        payment,
      };
    }
    return this.#refused(
      reject("settlement_in_progress", undefined, payment.payer),
      payment.network,
      payment,
      current.tx_hash,
    );
  }

  async #submit(row: AuthorizationRow, payment: ParsedPayment, signature: Hex): Promise<SettleResult> {
    const auth = payment.authorization;
    let txHash: Hex;
    try {
      ({ txHash } = await this.#gateway.settleAuthorization({
        token: this.asset.address,
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
        signature,
        ...(this.#relayer ? { relayer: this.#relayer } : {}),
      }));
    } catch (error) {
      if (error instanceof AgentBankError && error.code !== "chain_error") {
        // Nothing was broadcast: the dry run reverted or the gateway refused the call. If the
        // nonce is used anyway, someone else relayed this authorization (front-running).
        const onChain = await this.#findOnChainSettlement(row);
        if (onChain)
          return this.#settled(
            row,
            payment,
            onChain.txHash,
            onChain.blockNumber,
            "relayed by another account",
          );
        return this.#failed(row, payment, revertDetail(error), null);
      }
      // Unknown whether the transaction went out: keep the claim; a retry or the sweep resolves it.
      const detail = `submission outcome unknown: ${safeErrorMessage(error)}`;
      await this.#store.noteDetail(row.id, detail, this.#clock.now()).catch(() => undefined);
      this.#log.error(
        { event: "x402.settle", authorization: row.id, err: safeErrorMessage(error) },
        "settlement submission failed",
      );
      return this.#pending(payment, null);
    }

    try {
      await this.#store.markSubmitted(row.id, txHash, this.#clock.now());
    } catch (error) {
      // The transaction is out; the receipt (or the sweep, from the logs) still settles the row.
      this.#log.error(
        { event: "x402.settle", authorization: row.id, transaction: txHash, err: safeErrorMessage(error) },
        "could not record the settlement transaction",
      );
    }

    let outcome;
    try {
      outcome = await this.#receipts.wait(txHash, this.#receiptTimeoutMs);
    } catch (error) {
      this.#log.warn(
        { event: "x402.settle", transaction: txHash, err: safeErrorMessage(error) },
        "receipt lookup failed",
      );
      outcome = undefined;
    }
    if (!outcome) return this.#pending(payment, txHash);
    if (outcome.status === "success") return this.#settled(row, payment, txHash, outcome.blockNumber);
    const onChain = await this.#findOnChainSettlement(row);
    if (onChain)
      return this.#settled(row, payment, onChain.txHash, onChain.blockNumber, "relayed by another account");
    return this.#failed(row, payment, outcome.revertReason ?? "transferWithAuthorization reverted", txHash);
  }

  async #settled(
    row: AuthorizationRow,
    payment: ParsedPayment,
    txHash: Hex,
    blockNumber: bigint | null,
    note?: string,
  ): Promise<SettleResult> {
    try {
      await this.#store.markSettled(row.id, txHash, blockNumber, this.#clock.now());
    } catch (error) {
      // The chain is the truth: the payment happened. The sweep records it later.
      this.#log.error(
        { event: "x402.settle", authorization: row.id, transaction: txHash, err: safeErrorMessage(error) },
        "could not record the settlement",
      );
    }
    if (note)
      this.#log.warn(
        { event: "x402.settle", authorization: row.id, transaction: txHash },
        `authorization settled (${note})`,
      );
    return { outcome: "settled", reply: this.#successReply(payment, txHash), payment };
  }

  async #failed(
    row: AuthorizationRow,
    payment: ParsedPayment,
    detail: string,
    txHash: Hex | null,
  ): Promise<SettleResult> {
    const rejection = reject(
      "invalid_transaction_state",
      `The settlement reverted: ${detail}`,
      payment.payer,
    );
    try {
      await this.#store.markFailed(row.id, rejection.reason, rejection.message, this.#clock.now(), txHash);
    } catch (error) {
      this.#log.error(
        { event: "x402.settle", authorization: row.id, err: safeErrorMessage(error) },
        "could not record the failed settlement",
      );
    }
    return {
      outcome: "failed",
      reason: rejection.reason,
      reply: settleFailureReply(rejection, payment.network, txHash),
      payment,
    };
  }

  #pending(payment: ParsedPayment, txHash: Hex | null): SettleResult {
    const rejection = reject("settlement_pending", undefined, payment.payer);
    return {
      outcome: "pending",
      reason: rejection.reason,
      reply: settleFailureReply(rejection, payment.network, txHash),
      payment,
    };
  }

  #refused(
    rejection: Rejection,
    network: string,
    payment?: ParsedPayment,
    txHash?: string | null,
  ): SettleResult {
    const payer = rejection.payer ?? payment?.payer;
    return {
      outcome: isInfrastructureReason(rejection.reason) ? "error" : "rejected",
      reason: rejection.reason,
      reply: settleFailureReply(payer !== undefined ? { ...rejection, payer } : rejection, network, txHash),
      payment,
    };
  }

  #successReply(payment: ParsedPayment, txHash: string): FacilitatorReply<SettleResponse> {
    return {
      status: 200,
      body: {
        success: true,
        payer: payment.payer,
        transaction: txHash,
        network: payment.network,
        amount: payment.amount.toString(),
      },
    };
  }

  // ------------------------------------------------------------------------------- checks

  /**
   * Signature, single-use log, on-chain nonce state, balance and screening. Returns the
   * signature to submit (ECDSA normalized to v 27/28; contract signatures unwrapped).
   */
  async #checkAuthorization(payment: ParsedPayment, options: { checkLog: boolean }): Promise<Result<Hex>> {
    const auth = payment.authorization;
    const payer = payment.payer;
    const [deployed, row, usedOnChain, balance] = await Promise.all([
      this.#chainCall("isDeployed", () => this.#gateway.isDeployed(payer)),
      options.checkLog
        ? this.#db("find authorization", () => this.#store.findByKey(this.#key(payment)))
        : Promise.resolve(ok(undefined)),
      this.#chainCall("authorizationState", () =>
        this.#gateway.authorizationState(this.asset.address, payer, auth.nonce),
      ),
      this.#chainCall("getTokenBalance", () => this.#gateway.getTokenBalance(this.asset.address, payer)),
    ]);
    if (!deployed.ok) return deployed;
    const signature = await this.#checkSignature(payment, deployed.value);
    if (!signature.ok) return signature;
    if (!row.ok) return row;
    if (row.value) {
      const tx = row.value.tx_hash ? `, transaction ${row.value.tx_hash}` : "";
      return fail(
        reject(
          "authorization_already_used",
          `This authorization was already submitted to this facilitator (status: ${row.value.status}${tx})`,
          payer,
        ),
      );
    }
    if (!usedOnChain.ok) return usedOnChain;
    if (usedOnChain.value) {
      return fail(
        reject(
          "invalid_exact_evm_nonce_already_used",
          `Nonce ${auth.nonce} of ${payer} is already used or canceled on-chain`,
          payer,
        ),
      );
    }
    if (!balance.ok) return balance;
    if (balance.value < auth.value) {
      const d = this.asset.decimals;
      return fail(
        reject(
          "insufficient_funds",
          `The payer holds ${formatAmount(balance.value, d)} USDC; ${formatAmount(auth.value, d)} USDC is required`,
          payer,
        ),
      );
    }
    const screened = await this.#screen(payment);
    if (screened) return fail(screened);
    return signature;
  }

  /**
   * USDC's own rule (FiatToken v2.2 `SignatureChecker`): a payer with code (a contract wallet or
   * an EIP-7702 delegated EOA) is verified with ERC-1271 only, never `ecrecover`; any other payer
   * with ECDSA. ERC-6492 wrappers only work for deployed wallets (the inner signature is used):
   * USDC cannot deploy a counterfactual wallet.
   */
  async #checkSignature(payment: ParsedPayment, deployed: boolean): Promise<Result<Hex>> {
    const payer = payment.payer;
    const digest = authorizationDigest(this.asset, payment.authorization);
    const form = classifySignature(payment.signature);
    if (form.kind === "erc6492") {
      if (!deployed) {
        return fail(
          reject(
            "payer_not_deployed",
            `${payer} has no code: an ERC-6492 (counterfactual wallet) signature cannot settle because USDC does not deploy wallets. Deploy the wallet first or pay from an EOA spend key.`,
            payer,
          ),
        );
      }
      if (!form.inner)
        return fail(
          reject("invalid_exact_evm_payload_signature", "The ERC-6492 signature wrapper is malformed", payer),
        );
      return this.#checkContractSignature(payer, digest, form.inner, false);
    }
    if (deployed) return this.#checkContractSignature(payer, digest, form.signature, form.kind === "ecdsa");
    if (form.kind === "contract") {
      return fail(
        reject(
          "payer_not_deployed",
          `The ${size(form.signature)}-byte signature is not an ECDSA signature and no contract wallet is deployed at ${payer}`,
          payer,
        ),
      );
    }
    const signer = await recoverEcdsaSigner(digest, form.signature);
    if (!signer) {
      return fail(
        reject(
          "invalid_exact_evm_payload_signature",
          "The ECDSA signature is malformed or not canonical (v must be 27/28, s low)",
          payer,
        ),
      );
    }
    if (!isAddressEqual(signer, payer)) {
      return fail(
        reject(
          "invalid_exact_evm_payload_signature",
          `The authorization was signed by ${signer}, not by the payer ${payer}`,
          payer,
        ),
      );
    }
    return ok(normalizeEcdsaSignature(form.signature) as Hex);
  }

  /**
   * ERC-1271 for a payer with code. `plain` marks a bare 65-byte (ECDSA-shaped) signature: if the
   * payer's `isValidSignature` rejects it, the payer is a contract or a 7702-delegated EOA that
   * USDC will not let sign as an EOA (`payer_has_code`).
   */
  async #checkContractSignature(
    payer: Address,
    digest: Hex,
    signature: Hex,
    plain: boolean,
  ): Promise<Result<Hex>> {
    const refused = plain ? "payer_has_code" : "invalid_exact_evm_payload_signature";
    // Relays send 65-byte signatures through the (v, r, s) overload, which re-encodes v below 27:
    // only v 27/28 reaches isValidSignature byte for byte as verified here.
    if (size(signature) === 65) {
      const v = Number(BigInt(slice(signature, 64, 65)));
      if (v !== 27 && v !== 28) {
        return fail(
          reject(
            refused,
            `${payer} has code; a 65-byte signature for it must end in v 27 or 28 to reach isValidSignature unchanged`,
            payer,
          ),
        );
      }
    }
    const valid = await this.#chainCall("isValidSignature", () =>
      this.#contractSignatures({ address: payer, hash: digest, signature }),
    );
    if (!valid.ok) return valid;
    if (!valid.value) {
      return fail(
        reject(
          refused,
          plain
            ? `${payer} has code (a contract wallet or an EIP-7702 delegated EOA), so USDC checks its signatures with ERC-1271 isValidSignature, which rejects this ECDSA signature`
            : `The contract wallet ${payer} does not accept the signature (ERC-1271)`,
          payer,
        ),
      );
    }
    return ok(signature);
  }

  /**
   * The Agent Bank account behind `payTo` (read-only `x402_payee` lookup). In `registered` mode a
   * payTo that is not a registered payee on the served chain is refused.
   */
  async #payee(payment: ParsedPayment): Promise<Result<string | null>> {
    const found = await this.#db("find payee", () =>
      this.#store.findPayeeAccountId(payment.chainId, payment.payTo),
    );
    if (!found.ok) return found;
    if (this.payeeMode === "registered" && found.value === null) {
      return fail(
        reject(
          "payee_not_registered",
          `payTo ${payment.payTo} is not an Agent Bank account registered as an x402 payee on ${this.chain.caip2}`,
          payment.payer,
        ),
      );
    }
    return found;
  }

  /** Relayer gas guard: refuse (fail closed) while the relayer cannot pay for a settlement. */
  async #gas(): Promise<Rejection | undefined> {
    const guard = this.#relayerGas;
    if (!guard) return undefined;
    let check;
    try {
      check = await guard.check();
    } catch (error) {
      this.#log.warn(
        { event: "x402.gas", err: safeErrorMessage(error) },
        "relayer balance unreadable; failing closed",
      );
      return reject("chain_unavailable", "The relayer's gas balance could not be read; failing closed");
    }
    if (!check.ok) {
      this.#log.error(
        {
          event: "x402.gas",
          relayer: guard.address,
          balance_wei: check.balanceWei.toString(),
          min_balance_wei: guard.minBalanceWei.toString(),
        },
        "relayer gas balance below the minimum; refusing settlements",
      );
      return reject(
        "facilitator_unavailable",
        "The settlement relayer is low on gas; failing closed. Retry later.",
      );
    }
    return undefined;
  }

  async #screen(payment: ParsedPayment): Promise<Rejection | undefined> {
    let results: [ScreeningResult, ScreeningResult];
    try {
      results = await Promise.all([
        screenOrFail(this.#screening, payment.payer, this.#screeningTimeoutMs),
        screenOrFail(this.#screening, payment.payTo, this.#screeningTimeoutMs),
      ]);
    } catch (error) {
      this.#log.warn(
        { event: "x402.screening", err: safeErrorMessage(error) },
        "wallet screening unavailable; failing closed",
      );
      return reject("screening_unavailable", undefined, payment.payer);
    }
    const [payer, payee] = results;
    if (isBlocked(payer)) {
      return reject(
        "payer_blocked_by_screening",
        `The payer ${payment.payer} is blocked by wallet screening (${payer.provider})`,
        payment.payer,
      );
    }
    if (isBlocked(payee)) {
      return reject(
        "payee_blocked_by_screening",
        `The payee ${payment.payTo} is blocked by wallet screening (${payee.provider})`,
        payment.payer,
      );
    }
    return undefined;
  }

  // ------------------------------------------------------------------------------- recovery

  /**
   * Decide a `settling` row from the chain: its receipt when the transaction is known, else the
   * `AuthorizationUsed` log; an expired authorization that was never used is marked failed.
   * Anything still unknown stays `settling`.
   */
  async #resolveSettling(row: AuthorizationRow): Promise<AuthorizationRow> {
    try {
      if (row.tx_hash) {
        const outcome = await this.#receipts.wait(row.tx_hash as Hex, 0);
        if (outcome?.status === "success") {
          return (
            (await this.#store.markSettled(
              row.id,
              row.tx_hash as Hex,
              outcome.blockNumber,
              this.#clock.now(),
            )) ?? row
          );
        }
        if (outcome?.status === "reverted") {
          const onChain = await this.#findOnChainSettlement(row);
          if (onChain)
            return (
              (await this.#store.markSettled(
                row.id,
                onChain.txHash,
                onChain.blockNumber,
                this.#clock.now(),
              )) ?? row
            );
          const detail = `The settlement reverted: ${outcome.revertReason ?? "transferWithAuthorization reverted"}`;
          return (
            (await this.#store.markFailed(row.id, "invalid_transaction_state", detail, this.#clock.now())) ??
            row
          );
        }
      }
      const onChain = await this.#findOnChainSettlement(row);
      if (onChain)
        return (
          (await this.#store.markSettled(row.id, onChain.txHash, onChain.blockNumber, this.#clock.now())) ??
          row
        );
      const now = unixSeconds(this.#clock.now());
      if (BigInt(now) > row.valid_before + BigInt(this.#expiryGraceSeconds)) {
        const used = await this.#gateway.authorizationState(
          row.asset as Address,
          row.authorizer as Address,
          row.nonce as Hex,
        );
        if (!used) {
          const detail = "The authorization expired before its settlement was confirmed on-chain";
          return (
            (await this.#store.markFailed(row.id, "invalid_transaction_state", detail, this.#clock.now())) ??
            row
          );
        }
      }
    } catch (error) {
      this.#log.warn(
        { event: "x402.resolve", authorization: row.id, err: safeErrorMessage(error) },
        "could not resolve a pending settlement",
      );
    }
    return row;
  }

  /**
   * If the authorization's nonce is used on-chain, the transaction that used it with the
   * expected `Transfer(from, payTo, amount)` (ours, or another relayer's after front-running).
   */
  async #findOnChainSettlement(
    row: AuthorizationRow,
  ): Promise<{ txHash: Hex; blockNumber: bigint } | undefined> {
    try {
      const asset = row.asset as Address;
      const authorizer = row.authorizer as Address;
      if (!(await this.#gateway.authorizationState(asset, authorizer, row.nonce as Hex))) return undefined;
      const latest = await this.#gateway.getBlock("latest");
      const ageSeconds = Math.max(0, unixSeconds(this.#clock.now()) - unixSeconds(row.created_at));
      let span = BigInt(Math.ceil(ageSeconds / this.chain.blockTimeSeconds)) + 30n;
      if (span > MAX_LOOKBACK_BLOCKS) span = MAX_LOOKBACK_BLOCKS;
      const fromBlock = latest.number > span ? latest.number - span : 0n;
      const logs = await this.#gateway.getLogs({
        fromBlock,
        toBlock: latest.number,
        addresses: [asset],
        events: ["AuthorizationUsed", "Transfer"],
        involving: [authorizer],
      });
      const use = logs.find(
        (l) =>
          l.eventName === "AuthorizationUsed" &&
          typeof l.args.authorizer === "string" &&
          isAddressEqual(l.args.authorizer as Address, authorizer) &&
          String(l.args.nonce).toLowerCase() === row.nonce,
      );
      if (!use) return undefined;
      const transfer = logs.find(
        (l) =>
          l.eventName === "Transfer" &&
          l.txHash === use.txHash &&
          typeof l.args.from === "string" &&
          typeof l.args.to === "string" &&
          isAddressEqual(l.args.from as Address, authorizer) &&
          isAddressEqual(l.args.to as Address, row.pay_to as Address) &&
          String(l.args.value) === row.amount.toString(),
      );
      return transfer ? { txHash: use.txHash, blockNumber: use.blockNumber } : undefined;
    } catch (error) {
      this.#log.warn(
        { event: "x402.resolve", authorization: row.id, err: safeErrorMessage(error) },
        "could not read the chain",
      );
      return undefined;
    }
  }

  /**
   * Resolve `settling` rows older than `olderThanSeconds` (unconfirmed receipts, crashes between
   * broadcast and bookkeeping). Run periodically; safe on any number of replicas.
   */
  async sweepStale(
    olderThanSeconds = 60,
    limit = 50,
  ): Promise<{ checked: number; settled: number; failed: number }> {
    const before = new Date(this.#clock.now().getTime() - olderThanSeconds * 1000);
    const rows = await this.#store.listStaleSettling(this.chain.id, before, limit);
    let settled = 0;
    let failed = 0;
    for (const row of rows) {
      const resolved = await this.#resolveSettling(row);
      if (resolved.status === "settled") settled += 1;
      if (resolved.status === "failed") failed += 1;
    }
    return { checked: rows.length, settled, failed };
  }

  // ------------------------------------------------------------------------------- health

  /** Database must answer (else 503); an unreachable chain RPC makes the service `degraded` (200). */
  async health(timeoutMs = 3_000): Promise<HealthReport> {
    const checks: Record<string, string> = { network: this.chain.caip2 };
    const within = async <T>(run: () => Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(),
          new Promise<never>((_, rejectTimeout) => {
            timer = setTimeout(() => rejectTimeout(new Error("timeout")), timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    let dbOk = true;
    try {
      await within(() => this.#store.ping());
      checks.db = "ok";
    } catch {
      dbOk = false;
      checks.db = "unavailable";
    }
    let chainOk = true;
    try {
      const head = await within(() => this.#gateway.getBlock("latest"));
      checks.chain = "ok";
      checks.head = head.number.toString();
    } catch {
      chainOk = false;
      checks.chain = "unavailable";
    }
    let gasOk = true;
    const guard = this.#relayerGas;
    if (guard) {
      checks.relayer = guard.address;
      checks.relayer_min_balance_wei = guard.minBalanceWei.toString();
      try {
        const balance = await within(() => guard.balance());
        checks.relayer_balance_wei = balance.toString();
        gasOk = balance >= guard.minBalanceWei;
        checks.relayer_gas = gasOk ? "ok" : "low";
      } catch {
        gasOk = false;
        checks.relayer_gas = "unavailable";
      }
    }
    // Low gas or an unreachable chain degrade the service (200): restarting fixes neither.
    return { status: dbOk && chainOk && gasOk ? "ok" : "degraded", checks, httpStatus: dbOk ? 200 : 503 };
  }

  // ------------------------------------------------------------------------------- helpers

  #terms() {
    return { nowSeconds: unixSeconds(this.#clock.now()), maxSettlement: this.maxSettlement };
  }

  #key(payment: ParsedPayment): AuthorizationKey {
    return {
      chainId: payment.chainId,
      asset: payment.asset,
      authorizer: payment.payer,
      nonce: payment.authorization.nonce,
    };
  }

  #describe(payment: ParsedPayment): Record<string, unknown> {
    return {
      network: payment.network,
      pay_to: payment.payTo,
      amount: payment.amount.toString(),
      nonce: payment.authorization.nonce,
    };
  }

  async #chainCall<T>(operation: string, run: () => Promise<T>): Promise<Result<T>> {
    try {
      return ok(await run());
    } catch (error) {
      this.#log.warn(
        { event: "x402.chain", operation, err: safeErrorMessage(error) },
        "chain call failed; failing closed",
      );
      return fail(reject("chain_unavailable", `The chain RPC failed (${operation}); failing closed`));
    }
  }

  async #db<T>(operation: string, run: () => Promise<T>): Promise<Result<T>> {
    try {
      return ok(await run());
    } catch (error) {
      this.#log.error(
        { event: "x402.db", operation, err: safeErrorMessage(error) },
        "database call failed; failing closed",
      );
      return fail(
        reject("facilitator_unavailable", `The facilitator database failed (${operation}); failing closed`),
      );
    }
  }
}
