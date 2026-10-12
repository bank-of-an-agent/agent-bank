"use client";

import { useState, type FormEvent } from "react";
import { BrandLockup } from "@/components/shell/brand";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { TextField } from "@/components/ui/field";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { consolePost } from "@/lib/api/client";
import { ApiProblem } from "@/lib/api/problem";

export function StaffSignInForm({ next }: { next: string }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await consolePost("/api/admin/sign-in", { token: token.trim() });
      setToken("");
      window.location.assign(next);
    } catch (error) {
      setProblem(ApiProblem.from(error));
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-10">
      <BrandLockup subtitle="Staff" />
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Staff sign-in</h1>
        <p className="text-sm text-muted">
          Internal dashboards for Agent Bank operators. The token stays in an httpOnly cookie on this server.
        </p>
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <Card>
        <CardBody>
          <form onSubmit={submit} className="space-y-4" aria-label="Staff sign-in">
            <TextField
              label="Operator token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              inputClassName="font-mono"
            />
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={busy}
              disabled={!token.trim()}
            >
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
