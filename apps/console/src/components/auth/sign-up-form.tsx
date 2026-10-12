"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useOwnerKey } from "@/components/owner/owner-key-provider";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { IconKey, IconWallet } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout } from "@/components/ui/states";
import { consolePost, newIdempotencyKey } from "@/lib/api/client";
import { ApiProblem } from "@/lib/api/problem";
import { cn } from "@/lib/cn";

interface Created {
  org: { id: string; legal_name: string; owner_address: string };
  api_key: { id: string; name: string; prefix: string; secret: string };
}

export function SignUpForm() {
  const owner = useOwnerKey();
  const [legalName, setLegalName] = useState("");
  const [kind, setKind] = useState<"company" | "individual">("company");
  const [country, setCountry] = useState("US");
  const [email, setEmail] = useState("");
  const [ownerChoice, setOwnerChoice] = useState<"sandbox" | "wallet">("sandbox");
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [stored, setStored] = useState(false);

  const countryValid = /^[A-Za-z]{2}$/.test(country);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const signer =
        ownerChoice === "sandbox" ? owner.selectSandbox({ create: true }) : await owner.connectWallet();
      if (!signer) {
        setProblem(
          new ApiProblem({
            status: 0,
            code: "owner_key_missing",
            title: "No owner key",
            detail: owner.error ?? "Connect a wallet or generate a sandbox key to own this org.",
          }),
        );
        setBusy(false);
        return;
      }
      const result = await consolePost<Created>("/api/auth/sign-up", {
        legal_name: legalName.trim(),
        kind,
        country: country.toUpperCase(),
        contact_email: email.trim(),
        owner_address: signer.address,
        idempotency_key: idempotencyKey,
      });
      setCreated(result);
    } catch (error) {
      setProblem(ApiProblem.from(error));
    }
    setBusy(false);
  }

  if (created) {
    return (
      <div className="space-y-5">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{created.org.legal_name} is ready</h1>
          <p className="text-sm text-muted">You are signed in. Store your API key before you continue.</p>
        </div>
        <Card>
          <CardBody className="space-y-4">
            <Callout tone="warn" title="Shown once">
              This is the org&apos;s admin API key for automation and the SDKs. Agent Bank stores only its
              hash; copy it to your secret manager now. You cannot see it again.
            </Callout>
            <div>
              <p className="text-sm font-medium" id="new-key-label">
                {created.api_key.name}
              </p>
              <div className="mt-1 flex items-center gap-1 rounded-lg border border-line bg-subtle px-3 py-2">
                <code aria-labelledby="new-key-label" className="min-w-0 flex-1 font-mono text-xs break-all">
                  {created.api_key.secret}
                </code>
                <CopyButton value={created.api_key.secret} label="Copy API key" />
              </div>
            </div>
            <Checkbox
              label="I stored this key somewhere safe"
              checked={stored}
              onChange={(e) => setStored(e.target.checked)}
            />
            <Button
              variant="primary"
              className="w-full"
              disabled={!stored}
              onClick={() => window.location.assign("/")}
            >
              Continue to the console
            </Button>
            <p className="text-xs text-muted">
              Next: register a passkey in Settings so you can approve payments, then create your first agent.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create a sandbox org</h1>
        <p className="text-sm text-muted">Testnet only. KYB is auto-approved by the sandbox provider.</p>
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <Card>
        <CardBody>
          <form onSubmit={submit} className="space-y-4" aria-label="Create a sandbox org">
            <TextField
              label="Legal name"
              required
              value={legalName}
              maxLength={200}
              onChange={(e) => setLegalName(e.target.value)}
              autoComplete="organization"
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField
                label="Principal type"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="company">Company</option>
                <option value="individual">Individual</option>
              </SelectField>
              <TextField
                label="Country"
                required
                value={country}
                maxLength={2}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                hint="ISO 3166 two-letter code"
                error={country && !countryValid ? "Use a two-letter country code" : null}
                autoComplete="country"
              />
            </div>
            <TextField
              label="Contact email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              hint="Becomes the org's first admin member."
            />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Owner key</legend>
              <p className="text-xs text-muted">
                The owner key can always exit and is needed to loosen limits. Agent Bank never holds it.
              </p>
              <OwnerOption
                checked={ownerChoice === "sandbox"}
                onSelect={() => setOwnerChoice("sandbox")}
                icon={<IconKey size={16} className="text-amber-fg" />}
                title="Generate a sandbox owner key"
                description="A testnet-only key kept in this browser's storage. Never sent to Agent Bank."
              />
              <OwnerOption
                checked={ownerChoice === "wallet"}
                onSelect={() => setOwnerChoice("wallet")}
                icon={<IconWallet size={16} className="text-amber-fg" />}
                title="Use my browser wallet"
                description={
                  owner.walletAvailable
                    ? "Connect an EIP-1193 wallet (MetaMask, Rabby, …)."
                    : "No browser wallet detected."
                }
                disabled={!owner.walletAvailable}
              />
            </fieldset>
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={busy}
              disabled={!legalName.trim() || !email.trim() || !countryValid}
            >
              Create org
            </Button>
          </form>
        </CardBody>
      </Card>
      <p className="text-center text-sm text-muted">
        Already have an org?{" "}
        <Link href="/sign-in" className="font-medium text-blue-fg hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

function OwnerOption({
  checked,
  onSelect,
  icon,
  title,
  description,
  disabled = false,
}: {
  checked: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5",
        checked ? "border-amber bg-amber-bg" : "border-line hover:bg-subtle",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name="owner-key"
        className="mt-1 accent-amber"
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
      />
      <span className="space-y-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
        </span>
        <span className="block text-xs text-muted">{description}</span>
      </span>
    </label>
  );
}
