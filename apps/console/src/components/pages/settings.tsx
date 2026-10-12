"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { FreezeOrgButton, OrgFreezeDetails, UnfreezeOrgButton } from "@/components/agents/freeze-controls";
import { OwnerSignerPanel } from "@/components/owner/owner-signer-panel";
import { RotateOwnerKey } from "@/components/owner/rotate-owner";
import { SandboxKeyManager } from "@/components/owner/sandbox-key-manager";
import { useConsoleConfig, useSessionInfo } from "@/components/providers/config";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/field";
import { IconExternal, IconPasskey, IconPlus } from "@/components/ui/icons";
import { DescriptionList, PageHeader } from "@/components/ui/layout";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout, LoadingState } from "@/components/ui/states";
import { SecretOnceDialog } from "@/components/ui/secret-once";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { DateTimeValue, HexValue, IdValue } from "@/components/ui/values";
import { consolePost } from "@/lib/api/client";
import { apiFetch, useApi, useApiList, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import { ApiProblem } from "@/lib/api/problem";
import { chainLabel } from "@/lib/chains";
import { humanize } from "@/lib/format";
import { passkeysSupported, registerPasskey } from "@/lib/passkey";

const noopSubscribe = () => () => undefined;

function Organization() {
  const { chain } = useConsoleConfig();
  const org = useApi("getCurrentOrg");
  return (
    <Card aria-labelledby="org-title">
      <CardHeader id="org-title" title="Organization" />
      <CardBody>
        {org.error ? (
          <ProblemAlert problem={org.error} onRetry={() => void org.mutate()} />
        ) : !org.data ? (
          <LoadingState label="Loading organization" rows={3} className="px-0 py-0" />
        ) : (
          <DescriptionList
            columns={3}
            items={[
              { term: "Legal name", detail: org.data.legal_name },
              { term: "Org id", detail: <IdValue value={org.data.id} /> },
              { term: "Principal type", detail: humanize(org.data.kind) },
              { term: "Country", detail: org.data.country },
              { term: "Plan", detail: humanize(org.data.tier) },
              { term: "Status", detail: <StatusBadge status={org.data.status} /> },
              {
                term: "Owner key",
                detail: <HexValue value={org.data.owner_address} chain={chain} label="owner address" />,
              },
              {
                term: "Treasury account",
                detail: org.data.treasury_account_id ? (
                  <IdValue value={org.data.treasury_account_id} />
                ) : (
                  "Not set"
                ),
              },
              { term: "Network", detail: chainLabel(chain) },
              { term: "Created", detail: <DateTimeValue value={org.data.created_at} /> },
            ]}
          />
        )}
      </CardBody>
    </Card>
  );
}

function Verification() {
  const org = useApi("getCurrentOrg");
  const [key, rotate] = useIdempotencyKey();
  const start = useMutation(() => apiFetch("startKyb", { idempotencyKey: key }), {
    invalidates: ["getCurrentOrg"],
  });
  const [session, setSession] = useState<{
    provider: string;
    status: string;
    verification_url: string | null;
  } | null>(null);
  const status = session?.status ?? org.data?.kyc_status;
  return (
    <Card aria-labelledby="verification-title">
      <div id="verification" />
      <CardHeader
        id="verification-title"
        title="Verification (KYC/KYB)"
        description="Every agent account traces back to a verified principal."
        actions={status ? <StatusBadge status={status} /> : null}
      />
      <CardBody className="space-y-3">
        {status === "approved" ? (
          <p className="text-sm text-muted">Your organization is verified.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Verification runs with our identity vendor. In the sandbox it is approved automatically.
            </p>
            <Button
              variant="primary"
              loading={start.pending}
              onClick={async () => {
                const result = await start.run();
                if (result.ok) {
                  rotate();
                  setSession(result.data);
                }
              }}
            >
              {status === "in_review" ? "Check verification" : "Start verification"}
            </Button>
          </>
        )}
        {session?.verification_url ? (
          <a
            href={session.verification_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-blue-fg hover:underline"
          >
            Continue with {session.provider} <IconExternal size={14} />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
        {start.error ? <ProblemAlert problem={start.error} /> : null}
      </CardBody>
    </Card>
  );
}

function FreezeSection() {
  const org = useApi("getCurrentOrg");
  return (
    <Card aria-labelledby="freeze-title">
      <div id="freeze" />
      <CardHeader
        id="freeze-title"
        title="Emergency freeze"
        description="Freeze every agent at once. The co-signer then refuses every operation. Unfreezing needs the owner key and waits 1 hour."
        actions={org.data ? <StatusBadge status={org.data.status} /> : null}
      />
      <CardBody className="space-y-3">
        {org.data?.status === "frozen" ? (
          <>
            <div className="text-sm">
              <OrgFreezeDetails org={org.data} />
            </div>
            <UnfreezeOrgButton org={org.data} />
          </>
        ) : (
          <FreezeOrgButton />
        )}
      </CardBody>
    </Card>
  );
}

function InviteMemberForm() {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "approver" | "viewer">("approver");
  const [key, rotate] = useIdempotencyKey();
  const create = useMutation(
    () => apiFetch("createMember", { body: { email: email.trim(), role }, idempotencyKey: key }),
    {
      invalidates: ["listMembers"],
    },
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await create.run();
    if (result.ok) {
      rotate();
      setEmail("");
      toast({
        title: `${result.data.email} added`,
        description: "Create an invite link so they can register a passkey.",
      });
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Add a member">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <TextField
          label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
          <option value="admin">Admin</option>
          <option value="approver">Approver</option>
          <option value="viewer">Viewer</option>
        </SelectField>
        <Button
          type="submit"
          variant="primary"
          icon={<IconPlus size={16} />}
          loading={create.pending}
          disabled={!email.trim()}
        >
          Add member
        </Button>
      </div>
      {create.error ? <ProblemAlert problem={create.error} /> : null}
    </form>
  );
}

function Members() {
  const list = useApiList("listMembers", { query: { limit: 100 } });
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<ApiProblem | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function invite(memberId: string) {
    setInviting(memberId);
    setInviteError(null);
    try {
      const result = await consolePost<{ invite_token: string }>(`/api/auth/members/${memberId}/invite`);
      setLink(`${window.location.origin}/invite#token=${encodeURIComponent(result.invite_token)}`);
    } catch (error) {
      setInviteError(ApiProblem.from(error));
    }
    setInviting(null);
  }

  return (
    <Card aria-labelledby="members-title">
      <CardHeader
        id="members-title"
        title="Members and roles"
        description="Admins manage everything; approvers decide queued payments; viewers read."
      />
      <CardBody className="space-y-4">
        <InviteMemberForm />
        {inviteError ? <ProblemAlert problem={inviteError} /> : null}
      </CardBody>
      {list.error ? (
        <CardBody>
          <ProblemAlert problem={list.error} onRetry={() => void list.mutate()} />
        </CardBody>
      ) : list.isLoading ? (
        <LoadingState label="Loading members" rows={3} />
      ) : (
        <Table caption="Members">
          <THead>
            <tr>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Passkeys</Th>
              <Th>Added</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {list.items.map((member) => (
              <Tr key={member.id}>
                <Td className="font-medium">{member.email}</Td>
                <Td>
                  <Badge
                    tone={member.role === "admin" ? "warn" : member.role === "approver" ? "blue" : "neutral"}
                  >
                    {humanize(member.role)}
                  </Badge>
                </Td>
                <Td className="tabular">{member.passkey_count}</Td>
                <Td className="text-muted">
                  <DateTimeValue value={member.created_at} />
                </Td>
                <Td align="right">
                  <Button size="sm" loading={inviting === member.id} onClick={() => void invite(member.id)}>
                    Create invite link
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {link ? (
        <SecretOnceDialog
          open
          onClose={() => setLink(null)}
          title="Invite link"
          label="Single-use invite link (valid 7 days)"
          secret={link}
          description="Send it privately. Whoever opens it can register a passkey for this member. The token sits after # so it never reaches a server log."
        />
      ) : null}
    </Card>
  );
}

function Passkeys() {
  const session = useSessionInfo();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const supported = useSyncExternalStore(noopSubscribe, passkeysSupported, () => true);

  async function register() {
    setBusy(true);
    setProblem(null);
    try {
      await registerPasskey();
      toast({ title: "Passkey registered", description: "You are now signed in with your passkey." });
      window.location.reload();
    } catch (error) {
      setProblem(ApiProblem.from(error));
    }
    setBusy(false);
  }

  return (
    <Card aria-labelledby="passkeys-title">
      <CardHeader
        id="passkeys-title"
        title="Your passkeys"
        description="Passkeys sign you in and sign approval decisions. Hardware keys work too."
      />
      <CardBody className="space-y-3">
        {session?.kind === "api_key" ? (
          <Callout tone="info">
            You are signed in with an API key (sandbox). Register a passkey for the key&apos;s member to
            approve payments and sign in without the key.
          </Callout>
        ) : (
          <p className="text-sm text-muted">Signed in as {session?.email ?? "a member"} with a passkey.</p>
        )}
        <Button
          icon={<IconPasskey size={16} />}
          loading={busy}
          disabled={!supported}
          onClick={() => void register()}
        >
          Register a passkey on this device
        </Button>
        {!supported ? (
          <p className="text-sm text-danger-fg">This browser does not support passkeys.</p>
        ) : null}
        {problem ? <ProblemAlert problem={problem} /> : null}
      </CardBody>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization, verification, members, passkeys and your owner key."
      />
      <div className="space-y-6">
        <Organization />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Verification />
          <FreezeSection />
        </div>
        <Members />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Passkeys />
          <Card aria-labelledby="owner-title">
            <CardHeader
              id="owner-title"
              title="Owner key"
              description="Signs loosening changes, unfreezes, session grants, mandates and treasury rules. Never held by Agent Bank."
            />
            <CardBody className="space-y-4">
              <OwnerSignerPanel />
              <SandboxKeyManager />
              <RotateOwnerKey />
            </CardBody>
          </Card>
        </div>
        <Card aria-labelledby="appearance-title">
          <CardHeader
            id="appearance-title"
            title="Appearance"
            description="Follow the system theme or pick one."
          />
          <CardBody>
            <ThemeToggle />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
