import {
  disableModuleRegistryCall,
  EARLY_WITHDRAWAL_TYPES,
  TIME_LOCK_VAULTS_EIP712,
  topUpExecutorAbi,
  topUpExecutorInstallCalls,
  VAULT_MAX_LOCK_SECONDS,
  vaultCreateCall,
  vaultWithdrawCall,
  vaultWithdrawWithSignatureCall,
  type Call,
} from "@agentbank/chain";
import {
  AgentBankError,
  canonicalSha256,
  isAgentBankError,
  newId,
  ownerPayloads,
  toMinor,
  toPositiveMinor,
  unixSeconds,
  type DecisionInternal,
} from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import { encodeFunctionData, getAddress, recoverTypedDataAddress, type Hex } from "viem";
import type { AccountRow, AutoTopUpRuleRow, FundRow, OrgRow, SweepRuleRow, VaultRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { accountById, agentAccountOnChain, loadAccount, loadAgent, loadOrg } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import { contractAddress, usdcAddress } from "../domain/chain";
import { pocket, vaultPocketRef } from "../domain/ledger-refs";
import { ledgerIn } from "../domain/ledger-tx";
import { relay } from "../domain/followups";
import { verifyOwnerAuth } from "../domain/owner-auth";
import { insertOwnerOperation, prepareOwnerOperation } from "../domain/owner-ops";
import { createPaymentRecord } from "../domain/payments";
import type { AppDeps } from "../deps";
import { requirePrincipal, type AuthContext } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { serializeAutoTopUp, serializeFund, serializeSweepRule, serializeVault } from "../serializers";
import { OWNER_OPERATION_HEADER } from "./sessions";

/** Response header naming the payment that carries a locked-vault deposit. */
export const PAYMENT_HEADER = "agentbank-payment-id";

async function vaultBalance(deps: AppDeps, vault: VaultRow): Promise<bigint> {
  try {
    return await deps.ledger.balance(vaultPocketRef(vault.account_id, vault.id));
  } catch (error) {
    if (isAgentBankError(error) && error.code === "not_found") return 0n;
    throw error;
  }
}

async function vaultView(deps: AppDeps, vault: VaultRow) {
  return serializeVault(vault, await vaultBalance(deps, vault));
}

async function loadVault(
  deps: AppDeps,
  auth: AuthContext,
  id: string,
): Promise<{ vault: VaultRow; account: AccountRow }> {
  const vault = await one<VaultRow>(deps.db, "SELECT * FROM vault WHERE id = $1", [id]);
  if (!vault) throw new AgentBankError("not_found", "Vault not found");
  const account = await loadAccount(deps.db, auth, vault.account_id).catch(() => {
    throw new AgentBankError("not_found", "Vault not found");
  });
  return { vault, account };
}

function scopeOf(auth: AuthContext): string {
  return auth.kind === "agent"
    ? `agent:${auth.agentId}`
    : auth.kind === "principal"
      ? `org:${auth.orgId}`
      : auth.kind;
}

/** Two days of trailing seven-day spend (the design's default liquid floor). */
async function defaultFloor(deps: AppDeps, account: AccountRow, now: Date): Promise<bigint> {
  const row = await one<{ total: bigint | null }>(
    deps.db,
    `SELECT sum(amount + fee)::bigint AS total FROM payment
      WHERE account_id = $1 AND status = 'settled' AND settled_at > $2`,
    [account.id, new Date(now.getTime() - 7 * 86_400_000)],
  );
  return ((row?.total ?? 0n) * 2n) / 7n;
}

export const savingsHandlers: Pick<
  Handlers,
  | "createVault"
  | "listVaults"
  | "getVault"
  | "depositVault"
  | "withdrawVault"
  | "getAutoTopUp"
  | "putAutoTopUp"
  | "listAutoTopUpRules"
  | "listFunds"
  | "getSweepRule"
  | "putSweepRule"
> = {
  async createVault({ body }, { deps, auth, now }) {
    const account = await loadAccount(deps.db, auth, body.account_id);
    const target = body.target ? toPositiveMinor(body.target) : null;
    const id = newId("vault", now.getTime());
    if (body.kind === "goal") {
      if (body.unlock_at) throw new AgentBankError("invalid_request", "Goal vaults have no unlock_at");
      const vault = await deps.db.transaction(async (tx) => {
        const row = (await one<VaultRow>(
          tx,
          `INSERT INTO vault (id, account_id, kind, name, target, created_at) VALUES ($1, $2, 'goal', $3, $4, $5) RETURNING *`,
          [id, account.id, body.name, target, now],
        )) as VaultRow;
        await ledgerIn(deps, tx).ensureAccount({
          ...vaultPocketRef(account.id, id),
          location: "smart_account",
        });
        await audit(tx, now, {
          actor: actorOf(auth),
          action: "vault.create",
          subject: id,
          payload: { kind: "goal" },
        });
        return row;
      });
      return new Envelope(serializeVault(vault, 0n), 201);
    }
    // Locked vaults live in TimeLockVaults; creating one is an owner operation of the account.
    const principal = requirePrincipal(auth);
    if (!body.unlock_at) throw new AgentBankError("invalid_request", "Locked vaults need unlock_at");
    const unlockAt = new Date(body.unlock_at);
    if (
      unlockAt.getTime() <= now.getTime() ||
      BigInt(unixSeconds(unlockAt) - unixSeconds(now)) > VAULT_MAX_LOCK_SECONDS
    ) {
      throw new AgentBankError("invalid_request", "unlock_at must be in the future and within 10 years");
    }
    const contract = contractAddress(deps, "vaults");
    const org = await loadOrg(deps.db, principal.orgId);
    const prepared = await prepareOwnerOperation(
      deps,
      account,
      [
        vaultCreateCall({
          vaults: contract,
          token: usdcAddress(deps),
          unlockAt: BigInt(unixSeconds(unlockAt)),
          owner: getAddress(org.owner_address),
        }),
      ],
      now,
    );
    const { vault, opId } = await deps.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO vault (id, account_id, kind, name, target, unlock_at, contract_address, created_at)
         VALUES ($1, $2, 'locked', $3, $4, $5, $6, $7)`,
        [id, account.id, body.name, target, unlockAt, contract, now],
      );
      await ledgerIn(deps, tx).ensureAccount({
        ...vaultPocketRef(account.id, id),
        location: "vault_contract",
      });
      const op = await insertOwnerOperation(tx, {
        account,
        purpose: "account.deploy",
        subjectId: id,
        prepared,
        now,
      });
      const row = (await one<VaultRow>(
        tx,
        "UPDATE vault SET pending_operation_id = $2 WHERE id = $1 RETURNING *",
        [id, op.id],
      )) as VaultRow;
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "vault.create",
        subject: id,
        payload: { kind: "locked", unlock_at: unlockAt.toISOString() },
      });
      return { vault: row, opId: op.id };
    });
    return new Envelope(serializeVault(vault, 0n), 201, { [OWNER_OPERATION_HEADER]: opId });
  },

  async listVaults({ query }, { deps, auth }) {
    const params: SqlParam[] = [];
    let where: string;
    if (auth.kind === "agent") {
      if (query.account_id && query.account_id !== auth.accountId) return { data: [], next_cursor: null };
      params.push(auth.accountId);
      where = "v.account_id = $1";
    } else {
      const principal = requirePrincipal(auth);
      params.push(principal.orgId);
      where = "a.org_id = $1";
      if (query.account_id) {
        params.push(query.account_id);
        where += ` AND v.account_id = $${params.length}`;
      }
    }
    const sql = `SELECT v.* FROM vault v JOIN account a ON a.id = v.account_id WHERE ${where}${pageClause(
      decodeCursor(query.cursor),
      query.limit,
      params,
      "v",
    )}`;
    const page = toPage(await all<VaultRow>(deps.db, sql, params), query.limit);
    const data = [];
    for (const v of page.items) data.push(await vaultView(deps, v));
    return { data, next_cursor: page.nextCursor };
  },

  async getVault({ params }, { deps, auth }) {
    const { vault } = await loadVault(deps, auth, params.id);
    return vaultView(deps, vault);
  },

  async depositVault({ params, body }, { deps, auth, now, idempotencyKey }) {
    const { vault, account } = await loadVault(deps, auth, params.id);
    const amount = toPositiveMinor(body.amount);
    if (vault.kind === "goal") {
      await deps.ledger.post({
        idempotencyKey: `vault:${vault.id}:deposit:${scopeOf(auth)}:${idempotencyKey}`,
        lines: [
          { account: pocket(account.id, "operating"), amount: -amount },
          { account: vaultPocketRef(account.id, vault.id), amount },
        ],
        refType: "vault_deposit",
        refId: vault.id,
        agentId: account.agent_id,
        memo: `Deposit to ${vault.name}`,
      });
      return vaultView(deps, vault);
    }
    // Locked-vault deposits are owner operations in v1: the co-signer cannot verify vault
    // ownership from calldata, so agents deposit only into goal vaults.
    const principal = requirePrincipal(auth);
    if (!vault.onchain_id || !vault.contract_address) {
      throw new AgentBankError(
        "invalid_state",
        "The vault is not created on-chain yet (sign its owner operation)",
      );
    }
    if (!account.agent_id)
      throw new AgentBankError("invalid_request", "Locked-vault deposits are for agent accounts");
    const decision: DecisionInternal = {
      id: newId("decision", now.getTime()),
      outcome: "require_owner",
      rule_hits: [
        {
          rule: "vault.deposit",
          effect: "require_owner",
          detail: "Deposits into a time-locked vault are signed by the owner key",
        },
      ],
      approvers_required: 0,
      policy_version: 0,
      evaluated_at: now.toISOString(),
    };
    const payment = await createPaymentRecord(
      deps,
      {
        account,
        agentId: account.agent_id,
        sessionId: null,
        kind: "vault",
        amount,
        fee: 0n,
        counterparty: {
          counterparty_type: "address",
          counterparty_address: getAddress(vault.contract_address),
          counterparty_agent_id: null,
          counterparty_x402_domain: null,
        },
        memo: `Deposit to ${vault.name}`,
        mandateId: null,
        paymentRequestId: null,
        metadata: { vault_id: vault.id },
        idempotencyKey: `vault:${vault.id}:${principal.orgId}:${idempotencyKey}`,
        requestHash: canonicalSha256(body),
        vaultId: vault.id,
        decision,
        decisionSource: "api",
      },
      now,
    );
    const headers: Record<string, string> = { [PAYMENT_HEADER]: payment.id };
    let current = vault;
    if (payment.owner_operation_id) {
      headers[OWNER_OPERATION_HEADER] = payment.owner_operation_id;
      current =
        (await one<VaultRow>(
          deps.db,
          "UPDATE vault SET pending_operation_id = $2 WHERE id = $1 RETURNING *",
          [vault.id, payment.owner_operation_id],
        )) ?? vault;
    }
    return new Envelope(await vaultView(deps, current), 200, headers);
  },

  async withdrawVault({ params, body }, { deps, auth, now, idempotencyKey }) {
    const principal = requirePrincipal(auth);
    const { vault, account } = await loadVault(deps, principal, params.id);
    const amount = toPositiveMinor(body.amount);
    if (vault.kind === "goal") {
      await deps.ledger.post({
        idempotencyKey: `vault:${vault.id}:withdraw:${scopeOf(auth)}:${idempotencyKey}`,
        lines: [
          { account: vaultPocketRef(account.id, vault.id), amount: -amount },
          { account: pocket(account.id, "operating"), amount },
        ],
        refType: "vault_withdrawal",
        refId: vault.id,
        agentId: account.agent_id,
        memo: `Withdrawal from ${vault.name}`,
      });
      return vaultView(deps, vault);
    }
    if (!vault.onchain_id || !vault.contract_address)
      throw new AgentBankError("invalid_state", "The vault is not created on-chain yet");
    const vaults = getAddress(vault.contract_address);
    const vaultId = BigInt(vault.onchain_id);
    if (vault.unlock_at && now.getTime() >= vault.unlock_at.getTime()) {
      // Unlocked: anyone may withdraw, and funds can only go back to the parent account.
      await relay(deps, vaultWithdrawCall({ vaults, vaultId, amount }));
      await audit(deps.db, now, {
        actor: actorOf(auth),
        action: "vault.withdraw",
        subject: vault.id,
        payload: { amount: body.amount },
      });
      return vaultView(deps, vault);
    }
    // Early withdrawal: the vault owner (org owner key) signs TimeLockVaults' EIP-712
    // EarlyWithdrawal; the owner then signs the owner operation that carries it.
    const org = (await loadOrg(deps.db, principal.orgId)) as OrgRow;
    const deadline = BigInt(body.owner_authorization?.expires_at ?? unixSeconds(now) + 900);
    const typedData = {
      domain: { ...TIME_LOCK_VAULTS_EIP712, chainId: deps.config.chain.id, verifyingContract: vaults },
      types: EARLY_WITHDRAWAL_TYPES,
      primaryType: "EarlyWithdrawal" as const,
      message: { vaultId, amount, nonce: vault.early_nonce, deadline },
    };
    const describe = {
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        vaultId: vaultId.toString(),
        amount: amount.toString(),
        nonce: vault.early_nonce.toString(),
        deadline: deadline.toString(),
      },
    };
    if (!body.owner_authorization) {
      throw new AgentBankError(
        "owner_signature_required",
        "Early withdrawal needs the owner's TimeLockVaults EarlyWithdrawal signature: sign typed_data and send it as owner_authorization (expires_at = deadline)",
        { typed_data: describe },
      );
    }
    let signer: string;
    try {
      signer = await recoverTypedDataAddress({
        ...typedData,
        signature: body.owner_authorization.signature as Hex,
      });
    } catch {
      throw new AgentBankError("signature_invalid", "The early-withdrawal signature could not be recovered", {
        typed_data: describe,
      });
    }
    if (signer.toLowerCase() !== org.owner_address.toLowerCase()) {
      throw new AgentBankError(
        "owner_signature_required",
        "The early withdrawal must be signed by the owner key",
        { typed_data: describe },
      );
    }
    if (deadline <= BigInt(unixSeconds(now)))
      throw new AgentBankError("signature_invalid", "The early-withdrawal deadline passed");
    const prepared = await prepareOwnerOperation(
      deps,
      account,
      [
        vaultWithdrawWithSignatureCall({
          vaults,
          vaultId,
          amount,
          deadline,
          signature: body.owner_authorization.signature as Hex,
        }),
      ],
      now,
    );
    const { op, updated } = await deps.db.transaction(async (tx) => {
      const row = await insertOwnerOperation(tx, {
        account,
        purpose: "vault.withdraw",
        subjectId: vault.id,
        prepared,
        now,
      });
      const pending = (await one<VaultRow>(
        tx,
        "UPDATE vault SET pending_operation_id = $2 WHERE id = $1 RETURNING *",
        [vault.id, row.id],
      )) as VaultRow;
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "vault.early_withdraw_requested",
        subject: vault.id,
        payload: { amount: body.amount },
      });
      return { op: row, updated: pending };
    });
    return new Envelope(await vaultView(deps, updated), 200, { [OWNER_OPERATION_HEADER]: op.id });
  },

  async getAutoTopUp({ params }, { deps, auth }) {
    const agent = await loadAgent(deps.db, auth, params.id);
    const rule = await one<AutoTopUpRuleRow>(deps.db, "SELECT * FROM auto_topup_rule WHERE agent_id = $1", [
      agent.id,
    ]);
    return rule ? serializeAutoTopUp(rule) : null;
  },

  async putAutoTopUp({ params, body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const agent = await loadAgent(deps.db, principal, params.id);
    const org = await loadOrg(deps.db, principal.orgId);
    if (!org.treasury_account_id)
      throw new AgentBankError("invalid_state", "Create the org treasury account first");
    const treasury = (await accountById(deps.db, org.treasury_account_id)) as AccountRow;
    const agentAccount = await agentAccountOnChain(deps.db, agent.id, deps.config.chain.id);
    if (!agentAccount) throw new AgentBankError("invalid_state", "The agent has no account on this chain");
    const refillTo = toPositiveMinor(body.refill_to);
    const whenBelow = toMinor(body.when_below);
    const maxPerDay = toPositiveMinor(body.max_per_day);
    if (whenBelow >= refillTo)
      throw new AgentBankError("invalid_request", "when_below must be less than refill_to");
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.topUpSet(agent.id, {
        refill_to: body.refill_to,
        when_below: body.when_below,
        max_per_day: body.max_per_day,
      }),
      authorization: body.owner_authorization,
      now,
    });
    const executor = contractAddress(deps, "topUpExecutor");
    const token = usdcAddress(deps);
    const installed = await one(
      deps.db,
      "SELECT 1 AS x FROM auto_topup_rule WHERE treasury_account_id = $1 AND status = 'active'",
      [treasury.id],
    );
    const rule = { agent: getAddress(agentAccount.address), token, refillTo, whenBelow, maxPerDay };
    const calls: Call[] = installed
      ? [
          {
            to: executor,
            data: encodeFunctionData({
              abi: topUpExecutorAbi,
              functionName: "setRule",
              args: [rule.agent, token, refillTo, whenBelow, maxPerDay],
            }),
          },
        ]
      : [
          // Agent Bank's executors are not ERC-7484 attested: the owner turns registry checks off
          // in the same operation that installs the executor (both visible in what they sign).
          disableModuleRegistryCall({ account: getAddress(treasury.address) }),
          ...topUpExecutorInstallCalls({
            account: getAddress(treasury.address),
            contracts: deps.chain.contracts,
            rules: [rule],
          }),
        ];
    const prepared = await prepareOwnerOperation(deps, treasury, calls, now);
    const { row, opId } = await deps.db.transaction(async (tx) => {
      const ruleId = newId("topUpRule", now.getTime());
      const op = await insertOwnerOperation(tx, {
        account: treasury,
        purpose: "topup.configure",
        subjectId: agent.id,
        prepared,
        now,
      });
      const upserted = (await one<AutoTopUpRuleRow>(
        tx,
        `INSERT INTO auto_topup_rule (id, agent_id, treasury_account_id, refill_to, when_below, max_per_day, status,
                                      install_operation_id, owner_authorization, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_install', $7, $8, $9, $9)
         ON CONFLICT (agent_id) DO UPDATE SET treasury_account_id = EXCLUDED.treasury_account_id, refill_to = EXCLUDED.refill_to,
           when_below = EXCLUDED.when_below, max_per_day = EXCLUDED.max_per_day, status = 'pending_install',
           install_operation_id = EXCLUDED.install_operation_id, owner_authorization = EXCLUDED.owner_authorization,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [ruleId, agent.id, treasury.id, refillTo, whenBelow, maxPerDay, op.id, body.owner_authorization, now],
      )) as AutoTopUpRuleRow;
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "topup.set",
        subject: agent.id,
        payload: { refill_to: body.refill_to, when_below: body.when_below, max_per_day: body.max_per_day },
      });
      return { row: upserted, opId: op.id };
    });
    return new Envelope(serializeAutoTopUp(row), 200, { [OWNER_OPERATION_HEADER]: opId });
  },

  async listAutoTopUpRules({ query }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const params: SqlParam[] = [principal.orgId];
    const sql = `SELECT r.* FROM auto_topup_rule r JOIN agent g ON g.id = r.agent_id WHERE g.org_id = $1${pageClause(
      decodeCursor(query.cursor),
      query.limit,
      params,
      "r",
    )}`;
    const page = toPage(await all<AutoTopUpRuleRow>(deps.db, sql, params), query.limit);
    return { data: page.items.map(serializeAutoTopUp), next_cursor: page.nextCursor };
  },

  async getSweepRule({ params }, { deps, auth }) {
    const principal = requirePrincipal(auth);
    const account = await loadAccount(deps.db, principal, params.id);
    const rule = await one<SweepRuleRow>(deps.db, "SELECT * FROM sweep_rule WHERE account_id = $1", [
      account.id,
    ]);
    return rule ? serializeSweepRule(rule) : null;
  },

  async listFunds(_input, { deps }) {
    const funds = await all<FundRow>(deps.db, "SELECT * FROM fund WHERE chain_id = $1 ORDER BY name, id", [
      deps.config.chain.id,
    ]);
    return { data: funds.map(serializeFund) };
  },

  async putSweepRule({ params, body }, { deps, auth, now }) {
    if (!deps.config.features.treasurySweep) {
      throw new AgentBankError(
        "feature_gated",
        "The treasury sweep is disabled until counsel signs off (FEATURE_TREASURY_SWEEP)",
      );
    }
    const principal = requirePrincipal(auth);
    const account = await loadAccount(deps.db, principal, params.id);
    const org = await loadOrg(deps.db, principal.orgId);
    const fund = await one<FundRow>(deps.db, "SELECT * FROM fund WHERE id = $1 AND chain_id = $2", [
      body.fund_id,
      deps.config.chain.id,
    ]);
    if (!fund) throw new AgentBankError("not_found", "Fund not found on this chain");
    const { owner_authorization: authorization, ...rule } = body;
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.sweepSet(account.id, rule as Record<string, unknown>),
      authorization,
      now,
    });
    const floor = body.floor ? toMinor(body.floor) : await defaultFloor(deps, account, now);
    const threshold = toMinor(body.threshold);
    const row = await deps.db.transaction(async (tx) => {
      const upserted = (await one<SweepRuleRow>(
        tx,
        `INSERT INTO sweep_rule (id, account_id, fund_id, floor, threshold, max_share_bps, status, install_operation_id,
                                 signed_by, owner_authorization, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_install', NULL, $7, $8, $9)
         ON CONFLICT (account_id) DO UPDATE SET fund_id = EXCLUDED.fund_id, floor = EXCLUDED.floor,
           threshold = EXCLUDED.threshold, max_share_bps = EXCLUDED.max_share_bps, status = 'pending_install',
           signed_by = EXCLUDED.signed_by, owner_authorization = EXCLUDED.owner_authorization
         RETURNING *`,
        [
          newId("sweepRule", now.getTime()),
          account.id,
          fund.id,
          floor,
          threshold,
          body.max_share_bps,
          getAddress(authorization.signer),
          authorization,
          now,
        ],
      )) as SweepRuleRow;
      await audit(tx, now, { actor: actorOf(auth), action: "sweep.set", subject: account.id, payload: rule });
      return upserted;
    });
    return serializeSweepRule(row);
  },
};
