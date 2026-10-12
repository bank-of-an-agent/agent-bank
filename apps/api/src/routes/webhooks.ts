import { AgentBankError, newId } from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import { isIP } from "node:net";
import type { Config } from "../config";
import type { EventRow, WebhookEndpointRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { actorOf, audit } from "../domain/audit";
import { requirePrincipal } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeEvent, serializeWebhookEndpoint } from "../serializers";
import { newWebhookSecret } from "../util/crypto";
import { sealSecret } from "../util/secrets";

function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local"))
    return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (kind === 6)
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}

/**
 * Webhook URLs must be https and public (no credentials, no private or loopback hosts) unless
 * insecure URLs are allowed (development and tests).
 */
export function assertWebhookUrl(raw: string, config: Config): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentBankError("invalid_request", "url must be an absolute URL");
  }
  if (url.username || url.password)
    throw new AgentBankError("invalid_request", "url must not contain credentials");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentBankError("invalid_request", "url must use https");
  }
  if (config.webhookAllowInsecureUrls) return;
  if (url.protocol !== "https:") throw new AgentBankError("invalid_request", "url must use https");
  if (isPrivateHost(url.hostname)) {
    throw new AgentBankError("invalid_request", "url must point to a public host");
  }
}

export const webhookHandlers: Pick<
  Handlers,
  "createWebhookEndpoint" | "listWebhookEndpoints" | "deleteWebhookEndpoint" | "listEvents"
> = {
  async createWebhookEndpoint({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    assertWebhookUrl(body.url, deps.config);
    const id = newId("webhookEndpoint", now.getTime());
    const secret = newWebhookSecret();
    const events = [...new Set(body.events)];
    const endpoint = await deps.db.transaction(async (tx) => {
      const row = await one<WebhookEndpointRow>(
        tx,
        `INSERT INTO webhook_endpoint (id, org_id, url, events, secret, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'enabled', $6) RETURNING *`,
        [id, principal.orgId, body.url, events, sealSecret(secret, deps.config.webhookSigningKey), now],
      );
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "webhook_endpoint.create",
        subject: id,
        payload: { url: body.url, events },
      });
      return row as WebhookEndpointRow;
    });
    return new Envelope({ ...serializeWebhookEndpoint(endpoint), secret }, 201);
  },

  async listWebhookEndpoints({ query }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    const sql = `SELECT * FROM webhook_endpoint WHERE org_id = $1${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<WebhookEndpointRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map(serializeWebhookEndpoint), next_cursor: page.nextCursor };
  },

  async deleteWebhookEndpoint({ params }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const endpoint = await deps.db.transaction(async (tx) => {
      const row = await one<WebhookEndpointRow>(
        tx,
        "UPDATE webhook_endpoint SET status = 'disabled' WHERE id = $1 AND org_id = $2 RETURNING *",
        [params.id, principal.orgId],
      );
      if (!row) throw new AgentBankError("not_found", "Webhook endpoint not found");
      await tx.query(
        "UPDATE webhook_delivery SET status = 'dead', updated_at = $2, last_error = 'endpoint disabled' WHERE endpoint_id = $1 AND status = 'pending'",
        [params.id, now],
      );
      await audit(tx, now, { actor: actorOf(auth), action: "webhook_endpoint.disable", subject: params.id });
      return row;
    });
    return serializeWebhookEndpoint(endpoint);
  },

  async listEvents({ query }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    let where = "org_id = $1";
    if (query.type) {
      params.push(query.type);
      where += ` AND type = $${params.length}`;
    }
    const sql = `SELECT * FROM event WHERE ${where}${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<EventRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map(serializeEvent), next_cursor: page.nextCursor };
  },
};
