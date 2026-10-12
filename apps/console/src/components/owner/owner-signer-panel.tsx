"use client";

import { useConsoleConfig } from "@/components/providers/config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconKey, IconWallet } from "@/components/ui/icons";
import { Callout } from "@/components/ui/states";
import { HexValue } from "@/components/ui/values";
import { useApi } from "@/lib/api/hooks";
import { chainLabel } from "@/lib/chains";
import { sameAddress } from "@/lib/owner/signer";
import { useOwnerKey } from "./owner-key-provider";

/**
 * Shows which owner key will sign and lets the principal connect one:
 * a browser wallet, or (sandbox only) the testnet key kept in this browser.
 * Warns when the key is not the org's `owner_address`.
 */
export function OwnerSignerPanel() {
  const owner = useOwnerKey();
  const { sandbox, chain } = useConsoleConfig();
  const org = useApi("getCurrentOrg");
  const expected = org.data?.owner_address;
  const mismatch = owner.signer && expected ? !sameAddress(owner.signer.address, expected) : false;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber/60 bg-amber-bg px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <IconKey size={16} className="text-amber-fg" />
          <span className="font-semibold">Owner key</span>
          {owner.signer ? (
            <Badge tone={owner.signer.kind === "sandbox" ? "warn" : "amber"}>
              {owner.signer.kind === "sandbox" ? "Sandbox key · testnet only" : "Browser wallet"}
            </Badge>
          ) : (
            <Badge tone="neutral">Not connected</Badge>
          )}
          <span className="text-xs text-muted">Signs for {chainLabel(chain)}</span>
        </div>
        {owner.signer ? (
          <div className="mt-2">
            <HexValue value={owner.signer.address} chain={chain} label="owner key address" />
          </div>
        ) : (
          <p className="mt-1 text-muted">
            The owner key never leaves your wallet{sandbox ? " (or this browser, for the sandbox key)" : ""}.
            Agent Bank only receives the signature.
          </p>
        )}
        {expected ? (
          <p className="mt-2 text-xs text-muted">
            This org&apos;s owner address:{" "}
            <HexValue value={expected} chain={chain} label="org owner address" />
          </p>
        ) : null}
      </div>

      {mismatch ? (
        <Callout tone="danger" title="This key is not the org's owner key">
          The API only accepts signatures from the org owner address. Switch accounts in your wallet
          {sandbox ? " or use the sandbox key this org was created with" : ""}.
        </Callout>
      ) : null}

      {owner.error ? <Callout tone="danger">{owner.error}</Callout> : null}

      <div className="flex flex-wrap gap-2">
        {owner.walletAvailable ? (
          <Button
            size="sm"
            icon={<IconWallet size={16} />}
            loading={owner.connecting}
            onClick={() => void owner.connectWallet()}
          >
            {owner.signer?.kind === "injected" ? "Reconnect wallet" : "Connect browser wallet"}
          </Button>
        ) : (
          <p className="text-xs text-muted">No browser wallet detected.</p>
        )}
        {owner.sandboxAllowed ? (
          owner.sandboxKey ? (
            owner.signer?.kind !== "sandbox" ? (
              <Button size="sm" icon={<IconKey size={16} />} onClick={() => owner.selectSandbox()}>
                Use sandbox key
              </Button>
            ) : null
          ) : (
            <Button
              size="sm"
              icon={<IconKey size={16} />}
              onClick={() => owner.selectSandbox({ create: true })}
            >
              Generate sandbox key
            </Button>
          )
        ) : null}
        {owner.signer ? (
          <Button size="sm" variant="ghost" onClick={owner.disconnect}>
            Disconnect
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Whether the connected owner key may sign for the org right now. `reason`
 * is only set for states the signer panel does not already explain.
 */
export function useOwnerReady(): { ready: boolean; reason: string | null } {
  const owner = useOwnerKey();
  const org = useApi("getCurrentOrg");
  if (!owner.signer) return { ready: false, reason: null };
  const expected = org.data?.owner_address;
  if (!expected) {
    return {
      ready: false,
      reason: org.error ? "The org's owner address could not be loaded." : "Loading the org's owner address…",
    };
  }
  if (!sameAddress(owner.signer.address, expected)) return { ready: false, reason: null };
  return { ready: true, reason: null };
}
