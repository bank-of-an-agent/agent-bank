"use client";

import type { OwnerAuthorization } from "@agentbank/core";
import { useState } from "react";
import { getAddress, isAddress, zeroAddress } from "viem";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Callout } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, useApi, useIdempotencyKey, useMutation } from "@/lib/api/hooks";
import { shortHex } from "@/lib/format";
import { ownerPayloads } from "@/lib/owner/authorize";
import { sameAddress } from "@/lib/owner/signer";
import { OwnerActionDialog } from "./owner-action-dialog";

/** Validates the new owner address; the result is checksummed so the signed payload and the body match. */
export function parseNewOwner(
  input: string,
  currentOwner: string | null | undefined,
): { address: `0x${string}` | null; error: string | null } {
  const value = input.trim();
  if (!value) return { address: null, error: null };
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { address: null, error: "Enter a 0x-prefixed address of 40 hex characters." };
  }
  if (!isAddress(value)) {
    return {
      address: null,
      error: "The checksum (capitalisation) is wrong. Check the address or paste it in lower case.",
    };
  }
  const address = getAddress(value);
  if (address === zeroAddress)
    return { address: null, error: "The zero address cannot own an organization." };
  if (sameAddress(address, currentOwner)) return { address: null, error: "That is already the owner key." };
  return { address, error: null };
}

/**
 * Voluntary owner-key rotation (`POST /v1/orgs/me/owner`), signed by the
 * current owner key. A lost key cannot be rotated here: recovery goes through
 * the guardians on-chain.
 */
export function RotateOwnerKey() {
  const org = useApi("getCurrentOrg");
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [key, rotateKey] = useIdempotencyKey();
  const rotate = useMutation(
    ({ authorization, address }: { authorization: OwnerAuthorization; address: string }) =>
      apiFetch("rotateOwner", {
        body: { new_owner_address: address, owner_authorization: authorization },
        idempotencyKey: key,
      }),
    { invalidates: ["getCurrentOrg"] },
  );

  if (!org.data) return null;
  const orgId = org.data.id;
  const parsed = parseNewOwner(input, org.data.owner_address);

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="text-sm font-semibold">Rotate the owner key</p>
      <p className="text-sm text-muted">
        Hand ownership to a new key while you still hold the current one. If the current key is lost, recover
        the accounts on-chain with your guardians instead.
      </p>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Rotate owner key…
      </Button>
      <OwnerActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rotate the owner key"
        description="The current owner key signs the hand-over. Agent Bank and the co-signer then accept only the new key."
        request={parsed.address ? ownerPayloads.ownerRotate(orgId, parsed.address) : null}
        submitLabel="Sign and rotate"
        onSubmit={async (authorization, signed) => {
          const address = (signed.payload as { new_owner_address: string }).new_owner_address;
          const result = await rotate.run({ authorization, address });
          if (!result.ok) return result;
          rotateKey();
          setInput("");
          toast({
            title: "Owner key rotated",
            description: `Connect ${shortHex(address)} to sign owner actions from now on.`,
          });
          return { ok: true };
        }}
      >
        <TextField
          label="New owner address"
          required
          autoComplete="off"
          spellCheck={false}
          inputClassName="font-mono"
          placeholder="0x…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          error={parsed.error ?? undefined}
          hint="A key you control, ideally a hardware wallet. Agent Bank never holds it."
        />
        <Callout tone="warn" title="Change the smart accounts' owner on-chain too">
          This updates the owner Agent Bank and the co-signer recognise. Each smart account&apos;s on-chain
          owner must also be swapped to the new key, which the console cannot do for you yet.
        </Callout>
      </OwnerActionDialog>
    </div>
  );
}
