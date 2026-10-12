"use client";

import type { RequestInputOf } from "@agentbank/core/api";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, TextField } from "@/components/ui/field";
import { IconKey, IconPlus } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, EmptyState, LoadingState } from "@/components/ui/states";
import { SecretOnceDialog } from "@/components/ui/secret-once";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue } from "@/components/ui/values";
import { apiFetch, useApiList, useIdempotencyKey, useMutation } from "@/lib/api/hooks";

type Scope = NonNullable<RequestInputOf<"createApiKey">["body"]["scopes"]>[number];

const SCOPES: { id: Scope; label: string; description: string }[] = [
  {
    id: "admin",
    label: "Admin",
    description: "Everything, including members, keys and owner-signed changes",
  },
  {
    id: "agents:write",
    label: "Agents",
    description: "Create agents and accounts, freeze, policies, sessions",
  },
  { id: "payments:read", label: "Payments (read)", description: "Payments, approvals and escrow status" },
  { id: "approvals:decide", label: "Decide approvals", description: "Approve or deny queued payments" },
  { id: "ledger:read", label: "Ledger (read)", description: "Balances, entries and statements" },
  { id: "webhooks:write", label: "Webhooks", description: "Manage webhook endpoints" },
];

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["payments:read", "ledger:read"]);
  const [key, rotate] = useIdempotencyKey();
  const create = useMutation(
    () => apiFetch("createApiKey", { body: { name: name.trim(), scopes }, idempotencyKey: key }),
    {
      invalidates: ["listApiKeys"],
    },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await create.run();
    if (result.ok) {
      rotate();
      onCreated(result.data.secret);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create an API key"
      dismissible={!create.pending}
      description="For your own automation and the SDKs. Never give an API key to an agent: agents use session keys."
    >
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint="Where it is used, e.g. “billing job”."
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Scopes</legend>
          {SCOPES.map((scope) => (
            <Checkbox
              key={scope.id}
              label={
                <span>
                  {scope.label} <code className="font-mono text-xs text-muted">{scope.id}</code>
                </span>
              }
              hint={scope.description}
              checked={scopes.includes(scope.id)}
              onChange={(e) =>
                setScopes((list) =>
                  e.target.checked ? [...list, scope.id] : list.filter((s) => s !== scope.id),
                )
              }
            />
          ))}
        </fieldset>
        {scopes.includes("admin") ? (
          <Callout tone="warn">Admin keys can do anything an org admin can. Prefer narrow scopes.</Callout>
        ) : null}
        {create.error ? <ProblemAlert problem={create.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.pending}
            disabled={!name.trim() || scopes.length === 0}
          >
            Create key
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ApiKeysPage() {
  const toast = useToast();
  const list = useApiList("listApiKeys", { query: { limit: 50 } });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useMutation((id: string) => apiFetch("revokeApiKey", { params: { id } }), {
    invalidates: ["listApiKeys"],
  });

  return (
    <>
      <PageHeader
        title="API keys"
        description="Principal credentials for automation. Only a SHA-256 of each key is stored; the secret is shown once."
        actions={
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            Create API key
          </Button>
        }
      />
      <Card>
        <CardHeader title="Keys" />
        {revoke.error ? (
          <CardBody>
            <ProblemAlert problem={revoke.error} />
          </CardBody>
        ) : null}
        {list.error ? (
          <CardBody>
            <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
          </CardBody>
        ) : list.isLoading ? (
          <LoadingState label="Loading API keys" rows={3} />
        ) : list.items.length === 0 ? (
          <EmptyState icon={<IconKey size={20} />} title="No API keys" />
        ) : (
          <Table caption="API keys">
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Scopes</Th>
                <Th>Created</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <tbody>
              {list.items.map((apiKey) => (
                <Tr key={apiKey.id}>
                  <Td className="font-medium">{apiKey.name}</Td>
                  <Td>
                    <code className="font-mono text-xs">{apiKey.prefix}…</code>
                  </Td>
                  <Td>
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {apiKey.scopes.map((s) => (
                        <Badge key={s} tone={s === "admin" ? "warn" : "neutral"}>
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-muted">
                    <DateTimeValue value={apiKey.created_at} />
                  </Td>
                  <Td>
                    {apiKey.revoked_at ? (
                      <span className="flex flex-col gap-0.5">
                        <StatusBadge status="revoked" />
                        <span className="text-xs text-muted">
                          <DateTimeValue value={apiKey.revoked_at} />
                        </span>
                      </span>
                    ) : (
                      <StatusBadge status="active" />
                    )}
                  </Td>
                  <Td align="right">
                    {apiKey.revoked_at ? null : confirm === apiKey.id ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="danger"
                          loading={revoke.pending}
                          onClick={async () => {
                            const result = await revoke.run(apiKey.id);
                            if (result.ok) {
                              setConfirm(null);
                              toast({
                                title: "API key revoked",
                                description: "Requests with it are refused from now on.",
                              });
                            }
                          }}
                        >
                          Confirm revoke
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="danger" onClick={() => setConfirm(apiKey.id)}>
                        Revoke
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating ? (
        <CreateKeyDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(value) => {
            setCreating(false);
            setSecret(value);
          }}
        />
      ) : null}
      {secret ? (
        <SecretOnceDialog
          open
          onClose={() => setSecret(null)}
          title="Your new API key"
          label="API key"
          secret={secret}
          description="Store it in your secret manager now. Agent Bank keeps only a hash and cannot show it again."
        />
      ) : null}
    </>
  );
}
