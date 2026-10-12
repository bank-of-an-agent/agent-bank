"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { TextAreaField } from "@/components/ui/field";
import { IconAlert } from "@/components/ui/icons";
import { Callout } from "@/components/ui/states";
import { formatDateTime } from "@/lib/format";
import { useOwnerKey } from "./owner-key-provider";

/**
 * Sandbox only: back up, import or forget the testnet owner key kept in this
 * browser. The key is never sent to the console server or the API.
 */
export function SandboxKeyManager() {
  const owner = useOwnerKey();
  const [revealed, setRevealed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  if (!owner.sandboxAllowed) return null;
  const key = owner.sandboxKey;

  function doImport() {
    try {
      owner.importSandbox(importValue);
      setImportValue("");
      setImporting(false);
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not import the key.");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-warn/50 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <IconAlert size={16} className="text-warn-fg" />
        Sandbox owner key · testnet only
      </p>
      <p className="text-sm text-muted">
        Generated and stored in this browser&apos;s local storage; it never leaves it. Use it only for sandbox
        orgs on testnets. Clearing site data deletes it, so back it up if this org depends on it.
      </p>
      {key ? (
        <div className="space-y-2 text-sm">
          <p>
            Address <code className="font-mono text-xs break-all">{key.address}</code>
          </p>
          <p className="text-xs text-muted">Created {formatDateTime(key.createdAt)}</p>
          {revealed ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-warn-fg">
                Private key: anyone with it controls this sandbox org.
              </p>
              <div className="flex items-center gap-1">
                <code className="block rounded bg-subtle px-2 py-1 font-mono text-xs break-all">
                  {key.privateKey}
                </code>
                <CopyButton value={key.privateKey} label="Copy sandbox private key" />
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setRevealed((v) => !v)} aria-expanded={revealed}>
              {revealed ? "Hide private key" : "Back up private key"}
            </Button>
            {confirmForget ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    owner.forgetSandbox();
                    setConfirmForget(false);
                    setRevealed(false);
                  }}
                >
                  Delete key from this browser
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmForget(false)}>
                  Keep it
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmForget(true)}>
                Forget key
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {importing ? (
        <div className="space-y-2">
          <TextAreaField
            label="Sandbox private key"
            hint="32 bytes of hex. Testnet keys only; never paste a key that holds real funds."
            value={importValue}
            onChange={(e) => setImportValue(e.target.value)}
            rows={2}
            autoComplete="off"
            spellCheck={false}
            inputClassName="font-mono text-xs"
            error={importError}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={doImport} disabled={!importValue.trim()}>
              Import key
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setImporting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
          Import a sandbox key
        </Button>
      )}
      {!key && !importing ? (
        <Callout tone="info">
          No sandbox key in this browser yet. Generate one from the owner key panel above.
        </Callout>
      ) : null}
    </div>
  );
}
