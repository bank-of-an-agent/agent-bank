import { AuditPageInternal, verifyAuditChain, type AuditRecord } from "@agentbank/core";
import { describe, expect, it } from "vitest";
import { createCosigner } from "../src/create";
import { LocalSigner } from "../src/signer";
import { ANVIL_KEYS, createTestDb, PAYEE, REVENUE, SECRET, usd, World } from "./helpers";

async function withWorld(body: (w: World) => Promise<void>): Promise<void> {
  const w = await World.create();
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

/** Every kind of event the co-signer must audit, once each. */
async function exercise(w: World): Promise<void> {
  await w.pay(PAYEE, usd(5)); // co-signature
  await w.pay(PAYEE, usd(500)); // refusal
  await w.client.evaluate({
    org_id: w.org,
    agent_id: w.agent,
    account_id: w.accountId,
    account_address: w.account,
    chain_id: w.chain.chainId,
    intent: { kind: "transfer", amount: "1000000", asset: "USDC", counterparty: { address: PAYEE } },
  });
  await w.putPolicy(
    { limits: { per_tx: "50.00", per_day: "300.00", per_week: "1000.00", per_month: "3000.00" } },
    null,
  );
  await w.registerMandate("mdt_audit", [{ type: "payment.budget", currency: "USDC", max: "1000000" }]);
  await w.client.revokeMandate("mdt_audit");
  await w.client.freeze({ scope: "agent", id: w.agent, reason: "audit test" });
  await w.client.unfreeze(await w.unfreezeRequest("agent", w.agent));
  await w.client.revokeSession(w.sessionId);
}

async function auditRows(w: World): Promise<AuditRecord[]> {
  return (await w.client.audit(0, 1000)).records as AuditRecord[];
}

describe("hash-chained audit log", () => {
  it("records every decision, co-signature, refusal, policy change, freeze/unfreeze and session/mandate change", () =>
    withWorld(async (w) => {
      await exercise(w);
      const records = await auditRows(w);
      expect(AuditPageInternal.parse({ records })).toBeTruthy();
      const actions = new Set(records.map((r) => r.action));
      for (const action of [
        "session.registered",
        "policy.version",
        "cosign.signed",
        "cosign.refused",
        "decision.evaluated",
        "mandate.registered",
        "mandate.revoked",
        "freeze",
        "unfreeze.scheduled",
        "session.revoked",
      ]) {
        expect(actions, action).toContain(action);
      }
      expect(verifyAuditChain(records)).toBe(-1);
      expect(await w.service.verifyAudit()).toMatchObject({
        ok: true,
        records: records.length,
        brokenAt: null,
      });
      expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1));
    }));

  it("pages through the chain with after/limit", () =>
    withWorld(async (w) => {
      await exercise(w);
      const all = await auditRows(w);
      const first = await w.client.audit(0, 3);
      const next = await w.client.audit(3, 3);
      expect(first.records.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(next.records.map((r) => r.seq)).toEqual([4, 5, 6]);
      expect((await w.client.audit(all.length, 10)).records).toEqual([]);
      const bad = await w.inject({ method: "GET", url: "/internal/v1/audit?limit=5000" });
      expect(bad.statusCode).toBe(400);
    }));

  it("is append-only in the database itself", () =>
    withWorld(async (w) => {
      await w.pay(PAYEE, usd(1)); // a decision row exists
      const db = w.db;
      await expect(db.query("UPDATE audit_log SET actor = 'evil'")).rejects.toThrow(/append-only/);
      await expect(db.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
      await expect(db.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);
      await expect(db.query("UPDATE decision SET outcome = 'allow'")).rejects.toThrow(/append-only/);
    }));

  it("detects tampering with a record, a deleted record and a truncated tail", () =>
    withWorld(async (w) => {
      await exercise(w);
      const db = w.db;
      const records = await auditRows(w);
      const target = records.find((r) => r.action === "cosign.signed") as AuditRecord;
      const bypass = async (sql: string, params: unknown[] = []) => {
        await db.exec("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
        try {
          await db.query(sql, params as never);
        } finally {
          await db.exec("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
        }
      };
      // An insider rewrites what was co-signed.
      const forged = JSON.stringify({
        ...(target.payload as object),
        recipient: "0x000000000000000000000000000000000000dead",
      });
      await bypass("UPDATE audit_log SET payload = $1 WHERE seq = $2", [forged, target.seq]);
      expect(await w.service.verifyAudit()).toMatchObject({ ok: false, brokenAt: target.seq });
      expect(verifyAuditChain(await auditRows(w))).toBe(target.seq - 1);
      // Restoring the original content makes it verify again (hashes cover canonical JSON).
      await bypass("UPDATE audit_log SET payload = $1 WHERE seq = $2", [
        JSON.stringify(target.payload),
        target.seq,
      ]);
      expect((await w.service.verifyAudit()).ok).toBe(true);

      // Deleting a record in the middle.
      await bypass("DELETE FROM audit_log WHERE seq = $1", [3]);
      expect(await w.service.verifyAudit()).toMatchObject({ ok: false, brokenAt: 4 });
    }));

  it("detects a removed tail through the chain head, and reports it in /healthz", () =>
    withWorld(async (w) => {
      await exercise(w);
      const db = w.db;
      const last = (await auditRows(w)).at(-1) as AuditRecord;
      await db.exec("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
      await db.query("DELETE FROM audit_log WHERE seq = $1", [last.seq]);
      await db.exec("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
      expect(await w.service.verifyAudit()).toMatchObject({ ok: false, brokenAt: last.seq });
      const health = await w.client.health();
      expect(health.status).toBe("degraded");
      expect(health.checks.audit_chain).toMatch(/head/);
    }));
});

describe("audit export", () => {
  it("hands committed records, and only those, to the exporter", async () => {
    const { db, close } = await createTestDb();
    const exported: AuditRecord[] = [];
    const world = await World.create();
    try {
      const cosigner = await createCosigner({
        db,
        signer: LocalSigner.create({
          privateKey: ANVIL_KEYS.cosigner,
          chainId: world.chain.chainId,
          nodeEnv: "test",
        }),
        chain: world.chain.gateway,
        sharedSecret: SECRET,
        revenueAddress: REVENUE,
        clock: world.clock,
        auditExporter: { export: async (records) => void exported.push(...records) },
      });
      await cosigner.client.freeze({
        scope: "agent",
        id: "agt_01JAAAAAAAAAAAAAAAAAAAAAAA",
        reason: "export test",
      });
      await expect(
        cosigner.client.unfreeze({
          ...(await world.unfreezeRequest("agent", "agt_01JAAAAAAAAAAAAAAAAAAAAAAA")),
        }),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(exported.map((r) => r.action)).toEqual(["freeze"]);
      expect(verifyAuditChain(exported)).toBe(-1);
      await cosigner.close();
    } finally {
      await world.close();
      await close();
    }
  });
});
