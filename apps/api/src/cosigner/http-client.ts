import {
  AgentBankError,
  AuthorizeX402ResultInternal,
  CosignerHealth,
  CosignerRoutes,
  CosignResultInternal,
  DecisionInternal,
  EffectiveAtResponse,
  errorFromProblem,
  isAgentBankError,
  PolicyStateInternal,
  PolicyVersionInternal,
  signInternalRequest,
  type AuthorizeX402Internal,
  type CosignerClient,
  type CosignInternal,
  type EvaluateInternal,
  type FreezeInternal,
  type PutPolicyInternal,
  type RegisterMandateInternal,
  type RegisterSpendKeyInternal,
  type RegisterSessionInternal,
  type RotateOwnerInternal,
  type SetTreasuryInternal,
  type SettlementReportInternal,
  type UnfreezeInternal,
} from "@agentbank/core";
import type { ZodType } from "zod";

/**
 * `CosignerClient` over HTTP (apps/cosigner, separate cloud account). Every request carries
 * `Authorization: AgentBank-Internal t=…,v1=…` (HMAC over time, method, path and raw body).
 *
 * Fail closed: timeouts, network errors, 5xx, authentication failures (401: a configuration
 * problem on our side) and malformed responses all become `cosigner_unavailable` (503), so
 * nothing proceeds without a well-formed answer. A well-formed RFC 9457 refusal with another
 * 4xx status (e.g. `owner_signature_required`, `invalid_request`, `not_found`) is passed
 * through as that error: it is the co-signer saying no, not the co-signer being down.
 */

export interface HttpCosignerOptions {
  url: string;
  sharedSecret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Unix seconds for request signing (tests). */
  now?: () => number;
}

type Route = { method: string; path: string };

export class HttpCosignerClient implements CosignerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpCosignerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    route: Route,
    input: { params?: Record<string, string>; body?: unknown; schema?: ZodType<T> },
  ): Promise<T> {
    const path = route.path.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
      encodeURIComponent(input.params?.[name] ?? ""),
    );
    const raw = input.body === undefined ? "" : JSON.stringify(input.body);
    const t = this.options.now ? this.options.now() : Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      authorization: signInternalRequest(this.options.sharedSecret, route.method, path, raw, t),
      accept: "application/json",
    };
    if (raw.length > 0) headers["content-type"] = "application/json";
    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(`${this.options.url}${path}`, {
        method: route.method,
        headers,
        ...(raw.length > 0 ? { body: raw } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch {
      throw new AgentBankError("cosigner_unavailable", "Co-signer did not answer; failing closed");
    }
    if (status >= 400) {
      if (status < 500 && status !== 401 && status !== 429) {
        let problem: unknown;
        try {
          problem = JSON.parse(text);
        } catch {
          problem = undefined;
        }
        if (
          problem &&
          typeof problem === "object" &&
          typeof (problem as { code?: unknown }).code === "string"
        ) {
          const error = errorFromProblem(problem as Record<string, unknown>);
          if (error.code !== "internal") throw error;
        }
      }
      throw new AgentBankError("cosigner_unavailable", `Co-signer answered ${status}; failing closed`);
    }
    if (!input.schema) return undefined as T;
    try {
      return input.schema.parse(text.length > 0 ? JSON.parse(text) : undefined);
    } catch {
      throw new AgentBankError(
        "cosigner_unavailable",
        "Co-signer answered with a malformed response; failing closed",
      );
    }
  }

  private async call<T>(
    route: Route,
    input: { params?: Record<string, string>; body?: unknown; schema?: ZodType<T> },
  ): Promise<T> {
    try {
      return await this.request(route, input);
    } catch (error) {
      if (isAgentBankError(error)) throw error;
      throw new AgentBankError("cosigner_unavailable", "Co-signer request failed; failing closed");
    }
  }

  async registerSession(input: RegisterSessionInternal): Promise<void> {
    await this.call(CosignerRoutes.registerSession, { body: input });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.call(CosignerRoutes.revokeSession, { params: { id: sessionId } });
  }

  async putPolicy(input: PutPolicyInternal) {
    return this.call(CosignerRoutes.putPolicy, { body: input, schema: PolicyVersionInternal });
  }

  async getPolicy(agentId: string) {
    return this.call(CosignerRoutes.getPolicy, { params: { agentId }, schema: PolicyStateInternal });
  }

  async registerMandate(input: RegisterMandateInternal): Promise<void> {
    await this.call(CosignerRoutes.registerMandate, { body: input });
  }

  async setTreasury(input: SetTreasuryInternal): Promise<void> {
    await this.call(CosignerRoutes.setTreasury, { body: input });
  }

  async rotateOwner(input: RotateOwnerInternal): Promise<void> {
    await this.call(CosignerRoutes.rotateOwner, { body: input });
  }

  async registerSpendKey(input: RegisterSpendKeyInternal): Promise<void> {
    await this.call(CosignerRoutes.registerSpendKey, { body: input });
  }

  async revokeMandate(mandateId: string): Promise<void> {
    await this.call(CosignerRoutes.revokeMandate, { params: { id: mandateId } });
  }

  async freeze(input: FreezeInternal): Promise<void> {
    await this.call(CosignerRoutes.freeze, { body: input });
  }

  async unfreeze(input: UnfreezeInternal) {
    return this.call(CosignerRoutes.unfreeze, { body: input, schema: EffectiveAtResponse });
  }

  async evaluate(input: EvaluateInternal) {
    return this.call(CosignerRoutes.evaluate, { body: input, schema: DecisionInternal });
  }

  async cosign(input: CosignInternal) {
    return this.call(CosignerRoutes.cosign, { body: input, schema: CosignResultInternal });
  }

  async authorizeX402(input: AuthorizeX402Internal) {
    return this.call(CosignerRoutes.authorizeX402, { body: input, schema: AuthorizeX402ResultInternal });
  }

  async reportSettlement(input: SettlementReportInternal): Promise<void> {
    await this.call(CosignerRoutes.reportSettlement, { body: input });
  }

  async health(): Promise<CosignerHealth> {
    return this.call(CosignerRoutes.health, { schema: CosignerHealth });
  }
}
