import {
  AuditPageInternal,
  AuthorizeX402ResultInternal,
  CosignerHealth,
  CosignerRoutes,
  CosignResultInternal,
  DecisionInternal,
  EffectiveAtResponse,
  errorFromProblem,
  OkResponse,
  PolicyStateInternal,
  PolicyVersionInternal,
  signInternalRequest,
  systemClock,
  type AuthorizeX402Internal,
  type Clock,
  type CosignerClient,
  type CosignInternal,
  type EvaluateInternal,
  type FreezeInternal,
  type PutPolicyInternal,
  type RegisterMandateInternal,
  type RegisterSessionInternal,
  type RegisterSpendKeyInternal,
  type RotateOwnerInternal,
  type SetTreasuryInternal,
  type SettlementReportInternal,
  type UnfreezeInternal,
} from "@agentbank/core";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";

type Method = "GET" | "POST" | "DELETE";

/**
 * A `CosignerClient` that drives the co-signer's Fastify app in-process
 * (`app.inject`) through the full stack: HMAC request signing, routing,
 * schema validation and problem+json errors. For tests and the local
 * sandbox; the API's production client talks HTTP with the same signing.
 */
export class InjectCosignerClient implements CosignerClient {
  readonly #app: FastifyInstance;
  readonly #secret: string;
  readonly #clock: Clock;

  constructor(app: FastifyInstance, secret: string, clock: Clock = systemClock) {
    this.#app = app;
    this.#secret = secret;
    this.#clock = clock;
  }

  async #call<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.output<S>> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const t = Math.floor(this.#clock.now().getTime() / 1000);
    const res = await this.#app.inject({
      method,
      url: path,
      headers: {
        authorization: signInternalRequest(this.#secret, method, path, raw, t),
        ...(raw ? { "content-type": "application/json" } : {}),
      },
      ...(raw ? { payload: raw } : {}),
    });
    const json = res.body.length > 0 ? (JSON.parse(res.body) as unknown) : undefined;
    if (res.statusCode >= 400) throw errorFromProblem((json ?? {}) as Record<string, unknown>);
    return schema.parse(json);
  }

  async registerSession(input: RegisterSessionInternal): Promise<void> {
    await this.#call("POST", CosignerRoutes.registerSession.path, OkResponse, input);
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.#call("DELETE", `/internal/v1/sessions/${encodeURIComponent(sessionId)}`, OkResponse);
  }

  async putPolicy(input: PutPolicyInternal): Promise<z.output<typeof PolicyVersionInternal>> {
    return this.#call("POST", CosignerRoutes.putPolicy.path, PolicyVersionInternal, input);
  }

  async getPolicy(agentId: string): Promise<z.output<typeof PolicyStateInternal>> {
    return this.#call("GET", `/internal/v1/policies/${encodeURIComponent(agentId)}`, PolicyStateInternal);
  }

  async registerMandate(input: RegisterMandateInternal): Promise<void> {
    await this.#call("POST", CosignerRoutes.registerMandate.path, OkResponse, input);
  }

  async registerSpendKey(input: RegisterSpendKeyInternal): Promise<void> {
    await this.#call("POST", CosignerRoutes.registerSpendKey.path, OkResponse, input);
  }

  async setTreasury(input: SetTreasuryInternal): Promise<void> {
    await this.#call("POST", CosignerRoutes.setTreasury.path, OkResponse, input);
  }

  async rotateOwner(input: RotateOwnerInternal): Promise<void> {
    await this.#call("POST", CosignerRoutes.rotateOwner.path, OkResponse, input);
  }

  async revokeMandate(mandateId: string): Promise<void> {
    await this.#call("DELETE", `/internal/v1/mandates/${encodeURIComponent(mandateId)}`, OkResponse);
  }

  async freeze(input: FreezeInternal): Promise<void> {
    await this.#call("POST", CosignerRoutes.freeze.path, OkResponse, input);
  }

  async unfreeze(input: UnfreezeInternal): Promise<{ effective_at: string }> {
    return this.#call("POST", CosignerRoutes.unfreeze.path, EffectiveAtResponse, input);
  }

  async evaluate(input: EvaluateInternal): Promise<z.output<typeof DecisionInternal>> {
    return this.#call("POST", CosignerRoutes.evaluate.path, DecisionInternal, input);
  }

  async cosign(input: CosignInternal): Promise<z.output<typeof CosignResultInternal>> {
    return this.#call("POST", CosignerRoutes.cosign.path, CosignResultInternal, input);
  }

  async authorizeX402(input: AuthorizeX402Internal): Promise<z.output<typeof AuthorizeX402ResultInternal>> {
    return this.#call("POST", CosignerRoutes.authorizeX402.path, AuthorizeX402ResultInternal, input);
  }

  async reportSettlement(input: SettlementReportInternal): Promise<void> {
    await this.#call("POST", CosignerRoutes.reportSettlement.path, OkResponse, input);
  }

  async audit(after = 0, limit = 100): Promise<z.output<typeof AuditPageInternal>> {
    return this.#call("GET", `${CosignerRoutes.audit.path}?after=${after}&limit=${limit}`, AuditPageInternal);
  }

  async health(): Promise<z.output<typeof CosignerHealth>> {
    return this.#call("GET", CosignerRoutes.health.path, CosignerHealth);
  }
}
