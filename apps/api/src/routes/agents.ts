import { AgentBankError, newId } from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import type { AgentRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { loadAgent } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { freezeAgent, unfreezeAgent } from "../domain/freeze";
import { requirePrincipal } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeAgent } from "../serializers";
import { orgPlan } from "./orgs";

export const agentHandlers: Pick<
  Handlers,
  "createAgent" | "listAgents" | "getAgent" | "freezeAgent" | "unfreezeAgent"
> = {
  async createAgent({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const id = newId("agent", now.getTime());
    const agent = await deps.db.transaction(async (tx) => {
      const plan = await orgPlan(tx, principal.orgId);
      if (plan.max_agents !== null) {
        const count = await one<{ n: bigint }>(
          tx,
          "SELECT count(*)::bigint AS n FROM agent WHERE org_id = $1",
          [principal.orgId],
        );
        if ((count?.n ?? 0n) >= BigInt(plan.max_agents)) {
          throw new AgentBankError(
            "forbidden",
            `The ${plan.name} plan allows at most ${plan.max_agents} agents; change plan to add more`,
          );
        }
      }
      const row = await one<AgentRow>(
        tx,
        `INSERT INTO agent (id, org_id, name, description, erc8004_id, agent_card_url, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          id,
          principal.orgId,
          body.name,
          body.description ?? null,
          body.erc8004_id ?? null,
          body.agent_card_url ?? null,
          body.metadata ?? {},
          now,
        ],
      );
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "agent.create",
        subject: id,
        payload: { name: body.name },
      });
      return row as AgentRow;
    });
    return new Envelope(serializeAgent(agent), 201);
  },

  async listAgents({ query }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    let where = "org_id = $1";
    if (query.status) {
      params.push(query.status);
      where += ` AND status = $${params.length}`;
    }
    const sql = `SELECT * FROM agent WHERE ${where}${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<AgentRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map(serializeAgent), next_cursor: page.nextCursor };
  },

  async getAgent({ params }, { deps, auth }) {
    return serializeAgent(await loadAgent(deps.db, auth, params.id));
  },

  async freezeAgent({ params, body }, { deps, auth, now }) {
    return serializeAgent(await freezeAgent(deps, auth, params.id, body.reason, now));
  },

  async unfreezeAgent({ params, body }, { deps, auth, now }) {
    return serializeAgent(await unfreezeAgent(deps, auth, params.id, body, now));
  },
};
