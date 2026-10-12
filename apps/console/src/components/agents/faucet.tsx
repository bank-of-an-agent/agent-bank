"use client";

import { useState, type FormEvent } from "react";
import { useConsoleConfig } from "@/components/providers/config";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";
import { IconDroplet, IconExternal } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { useToast } from "@/components/ui/toast";
import { HexValue } from "@/components/ui/values";
import { apiFetch, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import type { Account } from "@/lib/api/queries";
import { amountError, compareDecimal, formatMoney } from "@/lib/money";

const MAX_PER_REQUEST = "10000.00";
const CIRCLE_FAUCET = "https://faucet.circle.com/";

/**
 * Sandbox only: test USDC for an account. The API mints it on the simulated
 * chain and Anvil; on Base Sepolia test USDC comes from Circle's faucet.
 */
export function TestUsdcButton({ account }: { account: Account }) {
  const { sandbox } = useConsoleConfig();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("100.00");
  const [key, rotate] = useIdempotencyKey();
  const mint = useMutation(
    () =>
      apiFetch("sandboxFaucet", {
        body: { account_id: account.id, amount: { amount, asset: "USDC" } },
        idempotencyKey: key,
      }),
    { invalidates: ["getBalances", "listEntries", "listPayments"] },
  );
  if (!sandbox) return null;
  if (account.chain === "base-sepolia") {
    return (
      <a
        href={CIRCLE_FAUCET}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm font-medium text-blue-fg hover:underline"
      >
        Get test USDC from Circle&apos;s faucet
        <IconExternal size={14} />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    );
  }
  const error =
    amountError(amount) ?? (compareDecimal(amount, MAX_PER_REQUEST) > 0 ? "At most 10,000.00 USDC" : null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await mint.run();
    if (!result.ok) return;
    rotate();
    setOpen(false);
    toast({
      title: `${formatMoney(result.data.amount)} test USDC sent`,
      description: "The balance updates once the deposit is indexed.",
    });
  }

  return (
    <>
      <Button size="sm" icon={<IconDroplet size={14} />} onClick={() => setOpen(true)}>
        Get test USDC
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Get test USDC"
        description="Sandbox only: mints test USDC to this account on the local chain. It has no value."
        size="sm"
        dismissible={!mint.pending}
      >
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm">
            To <HexValue value={account.address} chain={account.chain} label="account address" />
          </p>
          <TextField
            label="Amount (USDC)"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={amount ? error : null}
            hint="Up to 10,000.00 per request."
          />
          {mint.error ? <ProblemAlert problem={mint.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={mint.pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={mint.pending}
              disabled={!amount || Boolean(error)}
            >
              Send test USDC
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
