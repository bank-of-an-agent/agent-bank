"use client";

import {
  DEFAULT_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  SessionScopeSchema,
  type OwnerAuthorization,
  type SessionScope,
} from "@agentbank/core";
import { useState, type FormEvent } from "react";
import { OwnerActionDialog } from "@/components/owner/owner-action-dialog";
import { OwnerOperationCard } from "@/components/owner/owner-operation";
import { useConsoleConfig } from "@/components/providers/config";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Countdown } from "@/components/ui/countdown";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { IconKey, IconPlus } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Amount, HexValue, IdValue } from "@/components/ui/values";
import { apiFetch, useApi, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import type { Account, Agent } from "@/lib/api/queries";
import { formatDateTime } from "@/lib/format";
import { useKnownIds } from "@/lib/known-ids";
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
  onGranted: (sessionId: string) => void;
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
          onGranted(session.id);
          toast({ title: "Session granted", description: "Install it on-chain to activate the scope." });
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

function SessionItem({ id, onForget }: { id: string; onForget: () => void }) {
  const { chain } = useConsoleConfig();
  const toast = useToast();
  const session = useApi("getSession", { params: { id } });
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [installKey, rotateInstall] = useIdempotencyKey();
  const revoke = useMutation(() => apiFetch("revokeSession", { params: { id } }), {
    invalidates: ["getSession"],
  });
  const install = useMutation(
    () => apiFetch("installSession", { params: { id }, idempotencyKey: installKey }),
    {
      invalidates: ["getSession"],
    },
  );

  if (session.error) {
    return (
      <li className="space-y-2 px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <IdValue value={id} />
          <Button size="sm" variant="ghost" onClick={onForget}>
            Remove from list
          </Button>
        </div>
        <ProblemAlert problem={session.error} />
      </li>
    );
  }
  if (!session.data) {
    return (
      <li>
        <LoadingState label="Loading session" rows={1} />
      </li>
    );
  }
  const s = session.data;
  const live = s.status === "active" || s.status === "pending_install";
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
          {s.status === "pending_install" && !s.install_operation_id ? (
            <Button
              size="sm"
              variant="owner"
              loading={install.pending}
              onClick={async () => {
                const result = await install.run();
                if (result.ok) rotateInstall();
              }}
            >
              Install on-chain
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
                    if (result.ok) {
                      setConfirmRevoke(false);
                      toast({
                        title: "Session revoked",
                        description: "The co-signer refuses it from now on.",
                      });
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
          ) : (
            <Button size="sm" variant="ghost" onClick={onForget}>
              Remove from list
            </Button>
          )}
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
      {install.error ? <ProblemAlert problem={install.error} /> : null}
      {s.status === "revoked" ? (
        <Callout tone="info">
          Revoked off-chain: the co-signer refuses this key. The owner can also revoke the Smart Sessions
          permission on-chain as the hard backstop.
        </Callout>
      ) : null}
      {s.install_operation_id && s.status === "pending_install" ? (
        <OwnerOperationCard id={s.install_operation_id} title="Install the session on-chain" />
      ) : null}
    </li>
  );
}

export function SessionsCard({ agent, accounts }: { agent: Agent; accounts: Account[] }) {
  const [ids, remember, forget] = useKnownIds(`sessions.${agent.id}`);
  const [granting, setGranting] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookup, setLookup] = useState("");
  const lookupValid = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/.test(lookup.trim());

  function submitLookup(event: FormEvent) {
    event.preventDefault();
    if (!lookupValid) return;
    remember(lookup.trim());
    setLookup("");
    setLookupOpen(false);
  }

  return (
    <Card aria-labelledby="sessions-title">
      <CardHeader
        id="sessions-title"
        title="Session keys"
        description="Short-lived agent keys, useless without the co-signer and bounded by their on-chain scope."
        actions={
          <>
            <Button size="sm" onClick={() => setLookupOpen(true)}>
              Look up by id
            </Button>
            <Button
              size="sm"
              variant="owner"
              icon={<IconPlus size={16} />}
              disabled={accounts.length === 0}
              onClick={() => setGranting(true)}
            >
              Grant session
            </Button>
          </>
        }
      />
      {ids.length === 0 ? (
        <EmptyState
          icon={<IconKey size={20} />}
          title="No sessions in this browser"
          description={
            accounts.length === 0
              ? "Create the agent's smart account first."
              : "The API cannot list sessions yet. Sessions you grant or look up here are remembered in this browser."
          }
        />
      ) : (
        <>
          <p className="border-b border-line px-4 py-2 text-xs text-muted sm:px-5">
            Sessions granted or looked up in this browser (the API has no session list yet).
          </p>
          <ul className="divide-y divide-line">
            {ids.map((id) => (
              <SessionItem key={id} id={id} onForget={() => forget(id)} />
            ))}
          </ul>
        </>
      )}
      {granting ? (
        <GrantSessionDialog
          open={granting}
          onClose={() => setGranting(false)}
          accounts={accounts}
          onGranted={(id) => remember(id)}
        />
      ) : null}
      <Dialog open={lookupOpen} onClose={() => setLookupOpen(false)} title="Look up a session" size="sm">
        <form onSubmit={submitLookup} className="space-y-4">
          <TextField
            label="Session id"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="ses_…"
            spellCheck={false}
            inputClassName="font-mono"
            error={lookup && !lookupValid ? "Session ids look like ses_ followed by 26 characters" : null}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLookupOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!lookupValid}>
              Show session
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
