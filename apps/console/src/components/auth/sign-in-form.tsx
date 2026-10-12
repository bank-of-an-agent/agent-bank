"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { useConsoleConfig } from "@/components/providers/config";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { TextField } from "@/components/ui/field";
import { IconKey, IconPasskey } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { Callout } from "@/components/ui/states";
import { consolePost } from "@/lib/api/client";
import { ApiProblem } from "@/lib/api/problem";
import { passkeysSupported, signInWithPasskey } from "@/lib/passkey";

const noop = () => () => undefined;

export function SignInForm({ next, expired }: { next: string; expired: boolean }) {
  const { sandbox } = useConsoleConfig();
  const supported = useSyncExternalStore(noop, passkeysSupported, () => true);
  const [email, setEmail] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"passkey" | "api_key" | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);

  async function withPasskey(event: FormEvent) {
    event.preventDefault();
    setBusy("passkey");
    setProblem(null);
    try {
      await signInWithPasskey(showEmail && email.trim() ? email.trim() : undefined);
      window.location.assign(next);
    } catch (error) {
      setProblem(ApiProblem.from(error));
      setBusy(null);
    }
  }

  async function withApiKey(event: FormEvent) {
    event.preventDefault();
    setBusy("api_key");
    setProblem(null);
    try {
      await consolePost("/api/auth/api-key", { api_key: apiKey.trim() });
      setApiKey("");
      window.location.assign(next);
    } catch (error) {
      setProblem(ApiProblem.from(error));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to your org</h1>
        <p className="text-sm text-muted">Approve payments, freeze agents and manage policies.</p>
      </div>

      {expired ? (
        <Callout tone="info" title="Your session ended">
          Sign in again to continue.
        </Callout>
      ) : null}
      {problem ? <ProblemAlert problem={problem} /> : null}

      <Card>
        <CardBody className="space-y-4">
          <form onSubmit={withPasskey} className="space-y-4" aria-label="Sign in with a passkey">
            {showEmail ? (
              <TextField
                label="Email"
                type="email"
                autoComplete="username webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                hint="Only needed if your passkey is not discoverable on this device."
              />
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              icon={<IconPasskey size={18} />}
              loading={busy === "passkey"}
              disabled={busy !== null || !supported}
            >
              Sign in with a passkey
            </Button>
            {!supported ? (
              <p className="text-sm text-danger-fg">This browser does not support passkeys (WebAuthn).</p>
            ) : null}
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <button
                type="button"
                className="text-blue-fg hover:underline"
                onClick={() => setShowEmail((v) => !v)}
                aria-expanded={showEmail}
              >
                {showEmail ? "Hide email" : "Sign in with email and passkey"}
              </button>
              <Link href="/invite" className="text-blue-fg hover:underline">
                Have an invite?
              </Link>
            </div>
          </form>
        </CardBody>
      </Card>

      {sandbox ? (
        <Card aria-label="Sandbox sign-in">
          <CardBody className="space-y-4">
            <div className="space-y-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <IconKey size={16} className="text-warn-fg" />
                Sandbox: sign in with an org API key
              </h2>
              <p className="text-sm text-muted">
                The key is sent once to the console server and kept only in an httpOnly cookie. It is never
                stored by this page.
              </p>
            </div>
            <form onSubmit={withApiKey} className="space-y-3" aria-label="Sign in with an API key">
              <TextField
                label="API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="abk_test_…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                inputClassName="font-mono"
              />
              <Button
                type="submit"
                className="w-full"
                loading={busy === "api_key"}
                disabled={busy !== null || !apiKey.trim()}
              >
                Sign in with API key
              </Button>
            </form>
            <p className="text-center text-sm text-muted">
              New here?{" "}
              <Link href="/sign-up" className="font-medium text-blue-fg hover:underline">
                Create a sandbox org
              </Link>
            </p>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
