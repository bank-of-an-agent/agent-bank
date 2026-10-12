"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { TextField } from "@/components/ui/field";
import { IconPasskey } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { ApiProblem } from "@/lib/api/problem";
import { passkeysSupported, registerPasskey } from "@/lib/passkey";

const noop = () => () => undefined;

/** Invite links carry the token in the URL fragment, which browsers never send to a server. */
function tokenFromHash(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

export function InviteForm() {
  const supported = useSyncExternalStore(noop, passkeysSupported, () => true);
  const hashToken = useSyncExternalStore(noop, tokenFromHash, () => "");
  const [typed, setTyped] = useState<string | null>(null);
  const token = typed ?? hashToken;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await registerPasskey(token.trim());
      // Drop the token from the address bar and history before leaving.
      window.history.replaceState(null, "", "/invite");
      window.location.assign("/");
    } catch (error) {
      setProblem(ApiProblem.from(error));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Accept your invite</h1>
        <p className="text-sm text-muted">Create a passkey to sign in and to approve payments.</p>
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <Card>
        <CardBody>
          <form onSubmit={submit} className="space-y-4" aria-label="Register a passkey">
            <TextField
              label="Invite token"
              value={token}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="inv_…"
              hint="Your admin sent you a link or a token. Invites are single-use and expire after 7 days."
              inputClassName="font-mono"
              required
            />
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              icon={<IconPasskey size={18} />}
              loading={busy}
              disabled={!supported || token.trim().length < 16}
            >
              Create passkey
            </Button>
            {!supported ? (
              <p className="text-sm text-danger-fg">This browser does not support passkeys (WebAuthn).</p>
            ) : null}
          </form>
        </CardBody>
      </Card>
      <p className="text-center text-sm text-muted">
        Already registered?{" "}
        <Link href="/sign-in" className="font-medium text-blue-fg hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
