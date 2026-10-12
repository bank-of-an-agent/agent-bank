"use client";

import {
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  SessionScopeSchema,
  type OwnerAuthorization,
  type SessionScope,
} from "@agentbank/core";
import Link from "next/link";
import { useState } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { OwnerOperationDialog } from "@/components/owner/owner-operation";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { IconKey, IconPlus } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Amount, HexValue, IdValue } from "@/components/ui/values";
import { newIdempotencyKey } from "@/lib/api/client";
import { apiFetch, useApiList, useIdempotencyKey, useInvalidate, useMutation } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import {
  useOwnerInbox,
  type Account,
  type Agent,
  type OwnerOperation,
  type Session,
} from "@/lib/api/queries";
import { formatDateTime } from "@/lib/format";
import { amountError } from "@/lib/money";
import { ownerPayloads, type OwnerRequest } from "@/lib/owner/authorize";

const TTL_OPTIONS = [
  { seconds: 3600, label: "1 hour" },
  { seconds: DEFAULT_SESSION_TTL_SECONDS, label: "24 hours (default)" },
  { seconds: 3 * 86_400, label: "3 days" },
  { seconds: MAX_SESSION_TTL_SECONDS, label: "7 days (maximum)" },
];

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function lines(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function GrantSessionDialog({
  open,
  onClose,
  accounts,
  onGranted,
}: {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  onGranted: (session: Session) => void;
}) {
  const toast = useToast();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [publicKey, setPublicKey] = useState("");
  const [maxPerTx, setMaxPerTx] = useState("25.00");
  const [maxPerDay, setMaxPerDay] = useState("200.00");
  const [recipients, setRecipients] = useState("");
  const [ttl, setTtl] = useState(DEFAULT_SESSION_TTL_SECONDS);
  const [key, rotate] = useIdempotencyKey();

  const recipientList = lines(recipients);
  const errors = {
    publicKey:
      publicKey && !ADDRESS.test(publicKey.trim())
        ? "A session key address is 0x followed by 40 hex digits"
        : null,
    maxPerTx: maxPerTx ? amountError(maxPerTx) : "Required",
    maxPerDay: maxPerDay ? amountError(maxPerDay) : "Required",
    recipients: recipientList.some((r) => !ADDRESS.test(r))
      ? "Each recipient must be an address"
      : recipientList.length > 100
        ? "At most 100 recipients"
        : null,
  };
  const valid = Boolean(accountId && publicKey && !Object.values(errors).some(Boolean));

  // Expiry is stamped when the owner signs (see `finalize`); this placeholder is only shown before that.
  const request: OwnerRequest | null = valid
    ? ownerPayloads.sessionGrant({
        account_id: accountId,
        public_key: publicKey.trim(),
        scope: { asset: "USDC", max_per_tx: maxPerTx, max_per_day: maxPerDay, expires_at: "" },
      })
    : null;

  return (
    <OwnerActionDialog
      open={open}
      onClose={onClose}
      title="Grant a session key"
      description="The agent's runtime generates the session key; paste its address. The on-chain scope (caps, recipients, expiry) holds even if Agent Bank's servers were compromised."
      request={request}
      submitLabel="Sign and grant"
      finalize={(req) => {
        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        const scope = SessionScopeSchema.parse({
          asset: "USDC",
          max_per_tx: maxPerTx,
          max_per_day: maxPerDay,
          ...(recipientList.length ? { allowed_recipients: recipientList } : {}),
          expires_at: expiresAt,
        });
        return ownerPayloads.sessionGrant({
          account_id: req.subject,
          public_key: publicKey.trim(),
          scope,
        });
      }}
      onSubmit={async (authorization: OwnerAuthorization, signed) => {
        const payload = signed.payload as { account_id: string; public_key: string; scope: SessionScope };
        try {
          const session = await apiFetch("createSession", {
            body: { ...payload, owner_authorization: authorization },
            idempotencyKey: key,
          });
          rotate();
          onGranted(session);
          toast({
            title: "Session granted",
            description: "Next, sign its on-chain install with the owner key to activate the scope.",
          });
          return { ok: true };
        } catch (error) {
          return { ok: false, problem: ApiProblem.from(error) };
        }
      }}
    >
      <div className="space-y-4">
        {accounts.length > 1 ? (
          <SelectField label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.chain} · {a.address}
              </option>
            ))}
          </SelectField>
        ) : null}
        <TextField
          label="Session key address"
          required
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          inputClassName="font-mono"
          error={errors.publicKey}
          hint="From the agent runtime (the SDK generates session keys client-side)."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Max per payment (USDC)"
            required
            inputMode="decimal"
            value={maxPerTx}
            onChange={(e) => setMaxPerTx(e.target.value)}
            error={maxPerTx ? errors.maxPerTx : null}
          />
          <TextField
            label="Max per day (USDC)"
            required
            inputMode="decimal"
            value={maxPerDay}
            onChange={(e) => setMaxPerDay(e.target.value)}
            error={maxPerDay ? errors.maxPerDay : null}
          />
        </div>
        <TextAreaField
          label="Allowed recipients"
          rows={2}
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          hint="Optional. One address per line; leave empty to allow any recipient the policy allows."
          inputClassName="font-mono text-xs"
          error={errors.recipients}
        />
        <SelectField
          label="Expires after"
          value={String(ttl)}
          onChange={(e) => setTtl(Number(e.target.value))}
        >
          {TTL_OPTIONS.map((o) => (
            <option key={o.seconds} value={o.seconds}>
              {o.label}
            </option>
          ))}
        </SelectField>
      </div>
    </OwnerActionDialog>
  );
}

type InstallState = { pending: boolean; problem: ApiProblem | null };

/** Prepare (or reuse) the install operation, then hand its id to the signing dialog. */
function useInstall(onOperation: (id: string) => void) {
  const invalidate = useInvalidate();
  const [state, setState] = useState<InstallState>({ pending: false, problem: null });
  async function install(sessionId: string) {
    setState({ pending: true, problem: null });
    try {
      const session = await apiFetch("installSession", {
        params: { id: sessionId },
        idempotencyKey: newIdempotencyKey(),
      });
      setState({ pending: false, problem: null });
      void invalidate("listSessions", "getSession", "listOwnerOperations");
      if (session.install_operation_id) onOperation(session.install_operation_id);
    } catch (error) {
      setState({ pending: false, problem: ApiProblem.from(error) });
    }
  }
  return { ...state, install };
}

function SessionItem({
  session: s,
  waiting,
  onOperation,
}: {
  session: Session;
  /** Owner operations waiting for a signature, by id. */
  waiting: Map<string, OwnerOperation>;
  onOperation: (id: string, title: string) => void;
}) {
  const { chain } = useConsoleConfig();
  const toast = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const installer = useInstall((id) => onOperation(id, "Install the session on-chain"));
  const revoke = useMutation(() => apiFetch("revokeSession", { params: { id: s.id } }), {
    invalidates: ["listSessions", "getSession", "listOwnerOperations"],
  });
  const live = s.status === "active" || s.status === "pending_install";
  const installWaiting = s.install_operation_id ? waiting.get(s.install_operation_id) : undefined;
  const revokeWaiting = s.revoke_operation_id ? waiting.get(s.revoke_operation_id) : undefined;

  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <IconKey size={16} className="text-teal-fg" />
          <IdValue value={s.id} />
          <StatusBadge status={s.status} />
          {s.status === "active" ? <Countdown to={s.expires_at} warnBelowMs={60 * 60_000} /> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {s.status === "pending_install" ? (
            installWaiting ? (
              <Button
                size="sm"
                variant="owner"
                onClick={() => onOperation(installWaiting.id, "Install the session on-chain")}
              >
                Sign install…
              </Button>
            ) : (
              <Button
                size="sm"
                variant="owner"
                loading={installer.pending}
                onClick={() => void installer.install(s.id)}
              >
                Install on-chain…
              </Button>
            )
          ) : null}
          {revokeWaiting ? (
            <Button
              size="sm"
              variant="owner"
              onClick={() => onOperation(revokeWaiting.id, "Revoke the session on-chain")}
            >
              Sign on-chain revoke…
            </Button>
          ) : null}
          {live ? (
            confirmRevoke ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  loading={revoke.pending}
                  onClick={async () => {
                    const result = await revoke.run();
                    if (!result.ok) return;
                    setConfirmRevoke(false);
                    toast({
                      title: "Session revoked",
                      description: result.data.revoke_operation_id
                        ? "The co-signer refuses it now. Sign the on-chain revocation as the hard backstop."
                        : "The co-signer refuses it from now on.",
                    });
                    if (result.data.revoke_operation_id) {
                      onOperation(result.data.revoke_operation_id, "Revoke the session on-chain");
                    }
                  }}
                >
                  Confirm revoke
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmRevoke(true)}>
                Revoke
              </Button>
            )
          ) : null}
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Session key</dt>
          <dd>
            <HexValue value={s.public_key} chain={chain} label="session key address" />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Per payment / per day</dt>
          <dd>
            <Amount value={s.scope.max_per_tx} asset={s.scope.asset} /> /{" "}
            <Amount value={s.scope.max_per_day} asset={s.scope.asset} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Recipients</dt>
          <dd>
            {s.scope.allowed_recipients?.length ? (
              <Badge tone="teal">{s.scope.allowed_recipients.length} allowed</Badge>
            ) : (
              "Any allowed by policy"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{s.revoked_at ? "Revoked" : "Expires"}</dt>
          <dd>{formatDateTime(s.revoked_at ?? s.expires_at)}</dd>
        </div>
      </dl>
      {revoke.error ? <ProblemAlert problem={revoke.error} /> : null}
      {installer.problem ? <ProblemAlert problem={installer.problem} /> : null}
      {s.status === "revoked" ? (
        <p className="text-xs text-muted">
          {s.revoke_operation_id ? (
            revokeWaiting ? (
              "Revoked off-chain: the co-signer refuses this key. The on-chain revocation waits for the owner key."
            ) : (
              <>
                Revoked off-chain and on-chain removal prepared:{" "}
                <Link
                  href={`/owner-operations/${s.revoke_operation_id}`}
                  className="text-blue-fg hover:underline"
                >
                  view the owner operation
                </Link>
                .
              </>
            )
          ) : (
            "Revoked off-chain: the co-signer refuses this key. It was never installed on-chain."
          )}
        </p>
      ) : null}
    </li>
  );
}

export function SessionsCard({ agent, accounts }: { agent: Agent; accounts: Account[] }) {
  const list = useApiList("listSessions", { query: { agent_id: agent.id, limit: 25 } });
  const inbox = useOwnerInbox();
  const invalidate = useInvalidate();
  const [granting, setGranting] = useState(false);
  const [operation, setOperation] = useState<{ id: string; title: string } | null>(null);
  const installer = useInstall((id) => setOperation({ id, title: "Install the session on-chain" }));

  return (
    <Card aria-labelledby="sessions-title">
      <div id="sessions" />
      <CardHeader
        id="sessions-title"
        title="Session keys"
        description="Short-lived agent keys, useless without the co-signer and bounded by their on-chain scope."
        actions={
          <Button
            size="sm"
            variant="owner"
            icon={<IconPlus size={16} />}
            disabled={accounts.length === 0}
            onClick={() => setGranting(true)}
          >
            Grant session
          </Button>
        }
      />
      {installer.problem ? (
        <div className="px-4 pt-4 sm:px-5">
          <ProblemAlert problem={installer.problem} />
        </div>
      ) : null}
      {list.error ? (
        <div className="p-4 sm:px-5">
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        </div>
      ) : list.isLoading ? (
        <LoadingState label="Loading sessions" rows={2} />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon={<IconKey size={20} />}
          title="No sessions yet"
          description={
            accounts.length === 0
              ? "Create the agent's smart account first."
              : "Grant a session key to let the agent pay within an on-chain scope."
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {list.items.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                waiting={inbox.byId}
                onOperation={(id, title) => setOperation({ id, title })}
              />
            ))}
          </ul>
          {list.hasMore ? (
            <div className="border-t border-line p-3 text-center">
              <Button size="sm" onClick={list.loadMore} loading={list.isLoadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
      {granting ? (
        <GrantSessionDialog
          open={granting}
          onClose={() => setGranting(false)}
          accounts={accounts}
          onGranted={(session) => {
            void invalidate("listSessions");
            // Step 2: prepare the on-chain install and ask the owner to sign it.
            void installer.install(session.id);
          }}
        />
      ) : null}
      <OwnerOperationDialog
        id={operation?.id ?? null}
        open={operation !== null}
        onClose={() => setOperation(null)}
        title={operation?.title}
        description="The owner key signs this user operation's hash; Agent Bank submits it."
      />
    </Card>
  );
}
