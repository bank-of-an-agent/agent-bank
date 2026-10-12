"use client";

import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@agentbank/core";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { IconPlus, IconWebhook } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { SecretOnceDialog } from "@/components/ui/secret-once";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, IdValue } from "@/components/ui/values";
import { apiFetch, useApiList, useIdempotencyKey, useMutation } from "@/lib/api/hooks";

const GROUPS = WEBHOOK_EVENT_TYPES.reduce<Record<string, WebhookEventType[]>>((acc, type) => {
  const group = type.split(".")[0] ?? type;
  (acc[group] ??= []).push(type);
  return acc;
}, {});

const SUGGESTED: WebhookEventType[] = [
  "approval.requested",
  "payment.settled",
  "payment.failed",
  "payment.denied",
  "agent.frozen",
  "reconciliation.mismatch",
  "balance.low",
];

function CreateEndpointDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const [url, setUrl] = useState("https://");
  const [events, setEvents] = useState<WebhookEventType[]>(SUGGESTED);
  const [key, rotate] = useIdempotencyKey();
  const create = useMutation(
    () => apiFetch("createWebhookEndpoint", { body: { url: url.trim(), events }, idempotencyKey: key }),
    { invalidates: ["listWebhookEndpoints"] },
  );
  const urlValid = /^https?:\/\/[^\s]+$/.test(url.trim()) && url.trim() !== "https://";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await create.run();
    if (result.ok) {
      rotate();
      onCreated(result.data.secret);
    }
  }

  function toggle(type: WebhookEventType, on: boolean) {
    setEvents((list) =>
      on ? WEBHOOK_EVENT_TYPES.filter((t) => t === type || list.includes(t)) : list.filter((t) => t !== type),
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add a webhook endpoint"
      description="Events are signed with HMAC (AgentBank-Signature) and retried with backoff for 72 hours."
      dismissible={!create.pending}
    >
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Endpoint URL"
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          hint="HTTPS in production."
          error={url.length > 8 && !urlValid ? "Enter a full URL" : null}
        />
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Events ({events.length})</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Object.entries(GROUPS).map(([group, types]) => (
              <div key={group} className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{group}</p>
                {types.map((type) => (
                  <Checkbox
                    key={type}
                    label={<code className="font-mono text-xs">{type}</code>}
                    checked={events.includes(type)}
                    onChange={(e) => toggle(type, e.target.checked)}
                  />
                ))}
              </div>
            ))}
          </div>
        </fieldset>
        {create.error ? <ProblemAlert problem={create.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.pending}
            disabled={!urlValid || events.length === 0}
          >
            Add endpoint
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Endpoints() {
  const toast = useToast();
  const list = useApiList("listWebhookEndpoints", { query: { limit: 50 } });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const disable = useMutation((id: string) => apiFetch("deleteWebhookEndpoint", { params: { id } }), {
    invalidates: ["listWebhookEndpoints"],
  });

  return (
    <Card aria-labelledby="endpoints-title">
      <CardHeader
        id="endpoints-title"
        title="Endpoints"
        actions={
          <Button size="sm" variant="primary" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            Add endpoint
          </Button>
        }
      />
      {disable.error ? (
        <CardBody>
          <ProblemAlert problem={disable.error} />
        </CardBody>
      ) : null}
      {list.error ? (
        <CardBody>
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        </CardBody>
      ) : list.isLoading ? (
        <LoadingState label="Loading endpoints" rows={3} />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon={<IconWebhook size={20} />}
          title="No webhook endpoints"
          description="Get approvals, settlements, freezes and reconciliation alerts pushed to your systems."
        />
      ) : (
        <Table caption="Webhook endpoints">
          <THead>
            <tr>
              <Th>URL</Th>
              <Th>Events</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {list.items.map((endpoint) => (
              <Tr key={endpoint.id}>
                <Td>
                  <p className="max-w-xs font-mono text-xs break-all">{endpoint.url}</p>
                  <IdValue value={endpoint.id} />
                </Td>
                <Td>
                  <div className="flex max-w-sm flex-wrap gap-1">
                    {endpoint.events.slice(0, 4).map((e) => (
                      <Badge key={e}>
                        <code className="font-mono">{e}</code>
                      </Badge>
                    ))}
                    {endpoint.events.length > 4 ? <Badge>+{endpoint.events.length - 4} more</Badge> : null}
                  </div>
                </Td>
                <Td>
                  <StatusBadge status={endpoint.status} />
                </Td>
                <Td className="text-muted">
                  <DateTimeValue value={endpoint.created_at} />
                </Td>
                <Td align="right">
                  {endpoint.status === "enabled" ? (
                    confirm === endpoint.id ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="danger"
                          loading={disable.pending}
                          onClick={async () => {
                            const result = await disable.run(endpoint.id);
                            if (result.ok) {
                              setConfirm(null);
                              toast({ title: "Endpoint disabled" });
                            }
                          }}
                        >
                          Confirm
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" onClick={() => setConfirm(endpoint.id)}>
                        Disable
                      </Button>
                    )
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating ? (
        <CreateEndpointDialog
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
          title="Webhook signing secret"
          label="Signing secret"
          secret={secret}
          description="Verify every delivery's AgentBank-Signature header with this secret (the SDK's verifyWebhook does it). It is not shown again."
        />
      ) : null}
    </Card>
  );
}

function Events() {
  const [type, setType] = useState<WebhookEventType | "">("");
  const list = useApiList("listEvents", { query: { limit: 25, ...(type ? { type } : {}) } });
  return (
    <Card aria-labelledby="events-title">
      <div id="events" />
      <CardHeader
        id="events-title"
        title="Recent events"
        actions={
          <div className="w-56">
            <SelectField
              label="Event type"
              hideLabel
              value={type}
              onChange={(e) => setType(e.target.value as WebhookEventType | "")}
            >
              <option value="">All event types</option>
              {WEBHOOK_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </SelectField>
          </div>
        }
      />
      {list.error ? (
        <CardBody>
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        </CardBody>
      ) : list.isLoading ? (
        <LoadingState label="Loading events" rows={4} />
      ) : list.items.length === 0 ? (
        <EmptyState
          title="No events"
          description={type ? `No ${type} events yet.` : "Events appear as agents and payments change state."}
        />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {list.items.map((event) => (
              <li key={event.id} className="px-4 py-3 sm:px-5">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                    <Badge
                      tone={
                        event.type.includes("mismatch") ||
                        event.type.endsWith("failed") ||
                        event.type.endsWith("frozen")
                          ? "danger"
                          : "blue"
                      }
                    >
                      <code className="font-mono">{event.type}</code>
                    </Badge>
                    <span className="text-muted">
                      <DateTimeValue value={event.created_at} />
                    </span>
                    <code className="font-mono text-xs text-muted">{event.id}</code>
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-subtle p-3 font-mono text-xs">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </details>
              </li>
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
    </Card>
  );
}

export function WebhooksPage() {
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Notifications for approvals, settlements, denials, freezes, reconciliation and low balances."
      />
      <div className="space-y-6">
        <Endpoints />
        <Events />
      </div>
    </>
  );
}
