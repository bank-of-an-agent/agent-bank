import { AgentBankError, chainByName, isAgentBankError, newId, ownerPayloads } from "@agentbank/core";
import type { SqlParam } from "@agentbank/db";
import { getAddress } from "viem";
import type { AccountRow, OrgRow, VaultRow } from "../db/rows";
import { all, decodeCursor, one, pageClause, toPage } from "../db/sql";
import { loadAccount, loadAgent, loadOrg } from "../domain/access";
import { actorOf, audit } from "../domain/audit";
import {
  accountSalt,
  cosignerAddress,
  onChain,
  spendKeyPermitCall,
  usdcAddress,
  verifySpendKeyPermit,
} from "../domain/chain";
import { relay } from "../domain/followups";
import { verifyOwnerAuth } from "../domain/owner-auth";
import { ASSET } from "../domain/ledger-refs";
import type { AppDeps } from "../deps";
import { requirePrincipal } from "../http/auth";
import { Envelope, type Handlers } from "../http/registry";
import { decimal, iso, serializeAccount } from "../serializers";

const MODULE_VERSIONS = {
  safe: "1.4.1",
  erc7579_adapter: "safe7579",
  smart_sessions: "rhinestone",
  entry_point: "0.7",
};

function assertConfiguredChain(deps: AppDeps, name: string): void {
  const chain = chainByName(name); // refuses mainnets and unknown chains
  if (chain.id !== deps.config.chain.id) {
    throw new AgentBankError(
      "unsupported_chain",
      `This deployment runs on ${deps.config.chain.name}; accounts on ${chain.name} are not available here`,
    );
  }
}

function assertKybApproved(org: OrgRow): void {
  if (org.kyc_status !== "approved") {
    throw new AgentBankError("forbidden", "Complete KYC/KYB (POST /v1/orgs/me/kyb) before opening accounts");
  }
}

/**
 * A spend key must be a freshly generated EOA: no other account's key or address, not the owner,
 * and no code (a contract or an EIP-7702 delegation could sign permits and authorizations
 * the float limits do not bound).
 */
async function assertFreshSpendKey(
  deps: AppDeps,
  spendKey: string,
  account: { owner: string; address: string },
): Promise<void> {
  if (await onChain("isDeployed", () => deps.chain.isDeployed(getAddress(spendKey)))) {
    throw new AgentBankError(
      "invalid_request",
      "spend_key_address must be a plain EOA (no contract code or EIP-7702 delegation)",
    );
  }
  const clash = await one(
    deps.db,
    "SELECT 1 AS x FROM account WHERE lower(spend_key_address) = lower($1) OR lower(address) = lower($1)",
    [spendKey],
  );
  if (
    clash ||
    spendKey.toLowerCase() === account.owner.toLowerCase() ||
    spendKey.toLowerCase() === account.address.toLowerCase()
  ) {
    throw new AgentBankError(
      "invalid_request",
      "spend_key_address must be a fresh key used by no other account",
    );
  }
}

async function openAccount(
  deps: AppDeps,
  input: {
    org: OrgRow;
    agentId: string | null;
    role: "agent" | "treasury";
    spendKey: string | null;
    actor: string;
    now: Date;
  },
): Promise<AccountRow> {
  const { org, now } = input;
  const chainId = deps.config.chain.id;
  const cosigner = await cosignerAddress(deps);
  const salt = accountSalt(input.role, input.agentId ?? org.id, chainId);
  const owner = getAddress(org.owner_address);
  const address = await onChain("predictAccountAddress", () =>
    deps.chain.predictAccountAddress({ owner, cosigner, salt }),
  );
  const deployed = await onChain("isDeployed", () => deps.chain.isDeployed(address));
  if (input.spendKey) await assertFreshSpendKey(deps, input.spendKey, { owner, address });

  const id = newId("account", now.getTime());
  const account = await deps.db.transaction(async (tx) => {
    if (input.role === "agent") {
      const existing = await one(
        tx,
        "SELECT id FROM account WHERE agent_id = $1 AND chain_id = $2 AND role = 'agent'",
        [input.agentId, chainId],
      );
      if (existing) throw new AgentBankError("conflict", "The agent already has an account on this chain");
    } else {
      const existing = await one(
        tx,
        "SELECT id FROM account WHERE org_id = $1 AND chain_id = $2 AND role = 'treasury'",
        [org.id, chainId],
      );
      if (existing)
        throw new AgentBankError("conflict", "The org already has a treasury account on this chain");
    }
    const row = await one<AccountRow>(
      tx,
      `INSERT INTO account (id, org_id, agent_id, role, chain_id, address, deployed, owner_address, spend_key_address,
                            salt, module_versions, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        id,
        org.id,
        input.agentId,
        input.role,
        chainId,
        address,
        deployed,
        owner,
        input.spendKey ? getAddress(input.spendKey) : null,
        salt.toString(),
        MODULE_VERSIONS,
        now,
      ],
    );
    if (input.role === "agent") {
      await tx.query("UPDATE agent SET did = COALESCE(did, $2) WHERE id = $1", [
        input.agentId,
        `did:pkh:eip155:${chainId}:${address}`,
      ]);
    } else {
      await tx.query("UPDATE org SET treasury_account_id = COALESCE(treasury_account_id, $2) WHERE id = $1", [
        org.id,
        id,
      ]);
    }
    await audit(tx, now, {
      actor: input.actor,
      action: input.role === "agent" ? "account.create" : "treasury_account.create",
      subject: id,
      payload: { address, chain_id: chainId, agent_id: input.agentId },
    });
    return row as AccountRow;
  });
  await deps.ledger.openPockets(account.id, ASSET, chainId);
  return account;
}

/** Pocket balances, opening the pockets if a crash left an account without them. */
export async function pocketBalances(deps: AppDeps, account: AccountRow) {
  try {
    return await deps.ledger.pocketBalances(account.id, ASSET);
  } catch (error) {
    if (isAgentBankError(error) && error.code === "not_found") {
      await deps.ledger.openPockets(account.id, ASSET, account.chain_id);
      return deps.ledger.pocketBalances(account.id, ASSET);
    }
    throw error;
  }
}

export const accountHandlers: Pick<
  Handlers,
  "createAccount" | "attachSpendKey" | "createTreasuryAccount" | "listAccounts" | "getAccount" | "getBalances"
> = {
  async createAccount({ params, body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    assertConfiguredChain(deps, body.chain);
    const agent = await loadAgent(deps.db, principal, params.id);
    const org = await loadOrg(deps.db, principal.orgId);
    assertKybApproved(org);
    const account = await openAccount(deps, {
      org,
      agentId: agent.id,
      role: "agent",
      spendKey: body.spend_key_address ?? null,
      actor: actorOf(auth),
      now,
    });
    return new Envelope(serializeAccount(account, deps.config.chain.name), 201);
  },

  /**
   * Attach the agent's x402 spend key and its EIP-2612 float-recovery permit (ADR 0001). Before
   * the account is set up, the permit rides in the setup operation (the first session install);
   * afterwards the AgentPolicyHook refuses `permit` on the account's path, so it is submitted
   * straight to USDC by the relayer (`API_RELAYER_KEY`; anyone may submit a permit), or stays
   * `pending` for the owner to submit. The spend key cannot change once attached (the co-signer
   * pins it).
   */
  async attachSpendKey({ params, body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    const account = await loadAccount(deps.db, principal, params.id);
    if (account.role !== "agent" || !account.agent_id) {
      throw new AgentBankError("invalid_request", "Spend keys belong to agent accounts");
    }
    const org = await loadOrg(deps.db, principal.orgId);
    const spendKey = getAddress(body.spend_key_address);
    if (account.spend_key_address && getAddress(account.spend_key_address) !== spendKey) {
      throw new AgentBankError(
        "conflict",
        `The account's spend key is ${getAddress(account.spend_key_address)}; the co-signer pins it, so it cannot be replaced`,
      );
    }
    // Pinning the key is a loosening (refills may go to it): the owner signs `spend_key.set`.
    await verifyOwnerAuth(deps, {
      ownerAddress: org.owner_address,
      ...ownerPayloads.spendKeySet(account.id, body.spend_key_address),
      authorization: body.owner_authorization,
      now,
    });
    const same =
      account.spend_key_permit !== null &&
      account.spend_key_permit.signature.toLowerCase() === body.permit.signature.toLowerCase();
    if (account.spend_key_permit_status === "executed" && !same) {
      throw new AgentBankError("invalid_state", "The spend key's permit is already executed on-chain");
    }
    const unchanged = same && account.spend_key_permit_status !== "none";
    if (!unchanged) {
      if (!account.spend_key_address) {
        await assertFreshSpendKey(deps, spendKey, { owner: account.owner_address, address: account.address });
      }
      // The permit must carry the spend key's current USDC nonce, or it can never execute.
      const nonce = await onChain("erc20Nonces", () => deps.chain.erc20Nonces(usdcAddress(deps), spendKey));
      if (BigInt(body.permit.nonce) !== nonce) {
        throw new AgentBankError("invalid_request", `permit.nonce must be USDC.nonces(spend key) = ${nonce}`);
      }
      await verifySpendKeyPermit(deps, {
        spendKey,
        account: getAddress(account.address),
        permit: body.permit,
        now,
      });
    }
    // The co-signer pins the key (idempotent for the same key): until then it refuses x402 and refills.
    await deps.cosigner.registerSpendKey({
      org_id: org.id,
      agent_id: account.agent_id,
      account_id: account.id,
      account_address: getAddress(account.address),
      chain_id: deps.config.chain.id,
      owner_address: getAddress(org.owner_address),
      spend_key_address: body.spend_key_address,
      owner_authorization: body.owner_authorization,
    });
    if (unchanged) return serializeAccount(account, deps.config.chain.name);

    const deployed = await onChain("isDeployed", () => deps.chain.isDeployed(getAddress(account.address)));
    const inFlight = await one<{ id: string }>(
      deps.db,
      "SELECT id FROM owner_operation WHERE account_id = $1 AND status = 'submitted' AND purpose = 'session.install' LIMIT 1",
      [account.id],
    );
    if (!deployed && inFlight) {
      throw new AgentBankError(
        "invalid_state",
        "The account's setup operation is being submitted; attach the permit once it completes",
      );
    }
    const updated = await deps.db.transaction(async (tx) => {
      // An unsigned setup operation prepared before the permit does not carry it: retire it so the
      // next session install prepares one that does.
      const retired = deployed
        ? { rows: [] as { id: string }[] }
        : await tx.query<{ id: string }>(
            `UPDATE owner_operation SET status = 'expired', updated_at = $2
              WHERE account_id = $1 AND status = 'requires_signature' AND purpose = 'session.install' RETURNING id`,
            [account.id, now],
          );
      const row = (await one<AccountRow>(
        tx,
        `UPDATE account SET spend_key_address = $2, spend_key_permit = $3, spend_key_permit_status = 'pending',
                spend_key_permit_op_id = NULL
          WHERE id = $1 RETURNING *`,
        [account.id, spendKey, body.permit],
      )) as AccountRow;
      await audit(tx, now, {
        actor: actorOf(auth),
        action: "account.spend_key_attach",
        subject: account.id,
        payload: {
          spend_key_address: spendKey,
          value: body.permit.value,
          deadline: body.permit.deadline,
          retired_operations: retired.rows.map((r) => r.id),
        },
      });
      return row;
    });
    if (!deployed) return serializeAccount(updated, deps.config.chain.name);
    // Already set up: the hook refuses `permit` on the account's path, so the relayer submits it
    // straight to USDC (anyone may; it moves no funds). Without API_RELAYER_KEY it stays pending.
    const call = spendKeyPermitCall(deps, updated);
    try {
      if (!call) throw new AgentBankError("internal", "no permit to submit");
      const txHash = await relay(deps, call);
      const executed =
        (await one<AccountRow>(
          deps.db,
          "UPDATE account SET spend_key_permit_status = 'executed' WHERE id = $1 AND spend_key_permit_status = 'pending' RETURNING *",
          [account.id],
        )) ?? updated;
      await audit(deps.db, now, {
        actor: "system",
        action: "account.spend_key_permit_relayed",
        subject: account.id,
        payload: { tx_hash: txHash },
      });
      return serializeAccount(executed, deps.config.chain.name);
    } catch (error) {
      deps.logger.warn(
        { err: error, accountId: account.id },
        "could not relay the spend key permit; it stays pending for the owner to submit",
      );
      return serializeAccount(updated, deps.config.chain.name);
    }
  },

  async createTreasuryAccount({ body }, { deps, auth, now }) {
    const principal = requirePrincipal(auth);
    assertConfiguredChain(deps, body.chain);
    const org = await loadOrg(deps.db, principal.orgId);
    assertKybApproved(org);
    const account = await openAccount(deps, {
      org,
      agentId: null,
      role: "treasury",
      spendKey: null,
      actor: actorOf(auth),
      now,
    });
    return new Envelope(serializeAccount(account, deps.config.chain.name), 201);
  },

  async listAccounts({ query }, { deps, auth }) {
    const params: SqlParam[] = [];
    let where: string;
    if (auth.kind === "agent") {
      params.push(auth.accountId);
      where = "id = $1";
    } else {
      const principal = requirePrincipal(auth);
      params.push(principal.orgId);
      where = "org_id = $1";
      if (query.agent_id) {
        params.push(query.agent_id);
        where += ` AND agent_id = $${params.length}`;
      }
    }
    const sql = `SELECT * FROM account WHERE ${where}${pageClause(decodeCursor(query.cursor), query.limit, params)}`;
    const page = toPage(await all<AccountRow>(deps.db, sql, params), query.limit);
    return {
      data: page.items.map((a) => serializeAccount(a, deps.config.chain.name)),
      next_cursor: page.nextCursor,
    };
  },

  async getAccount({ params }, { deps, auth }) {
    return serializeAccount(await loadAccount(deps.db, auth, params.id), deps.config.chain.name);
  },

  async getBalances({ params }, { deps, auth, now }) {
    const account = await loadAccount(deps.db, auth, params.id);
    const balances = await pocketBalances(deps, account);
    const vaults = await all<VaultRow>(
      deps.db,
      "SELECT * FROM vault WHERE account_id = $1 ORDER BY created_at",
      [account.id],
    );
    const get = (pocket: string): bigint => (balances as Record<string, bigint>)[pocket] ?? 0n;
    let vaultTotal = 0n;
    const vaultBalances = vaults.map((v) => {
      const balance = get(`vault:${v.id}`);
      vaultTotal += balance;
      return { vault_id: v.id, name: v.name, balance: decimal(balance) };
    });
    let total = 0n;
    for (const value of Object.values(balances as Record<string, bigint>)) total += value;
    return {
      object: "balances",
      account_id: account.id,
      asset: "USDC",
      available: decimal(get("operating")),
      reserved: decimal(get("reserved")),
      escrow: decimal(get("escrow") + get("stream")),
      fees: decimal(get("fees")),
      savings: decimal(get("savings") + vaultTotal),
      spend_float: decimal(get("spend") + get("spend_reserved")),
      vaults: vaultBalances,
      total: decimal(total),
      as_of: iso(now),
    };
  },
};
