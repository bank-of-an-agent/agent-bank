"use client";

import { useState } from "react";
import { Button } from "./button";
import { CopyButton } from "./copy-button";
import { Dialog } from "./dialog";
import { Checkbox } from "./field";
import { Callout } from "./states";

/**
 * Shows a secret exactly once (API keys, webhook signing secrets, invite
 * links). Closing requires confirming it was stored; nothing keeps a copy.
 */
export function SecretOnceDialog({
  open,
  onClose,
  title,
  label,
  secret,
  description,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  label: string;
  secret: string;
  description: string;
}) {
  const [stored, setStored] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (stored) onClose();
      }}
      dismissible={stored}
      title={title}
      footer={
        <Button variant="primary" disabled={!stored} onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        <Callout tone="warn" title="Shown once">
          {description}
        </Callout>
        <div>
          <p className="text-sm font-medium" id="secret-once-label">
            {label}
          </p>
          <div className="mt-1 flex items-center gap-1 rounded-lg border border-line bg-subtle px-3 py-2">
            <code aria-labelledby="secret-once-label" className="min-w-0 flex-1 font-mono text-xs break-all">
              {secret}
            </code>
            <CopyButton value={secret} label={`Copy ${label}`} />
          </div>
        </div>
        <Checkbox
          label="I stored it somewhere safe"
          checked={stored}
          onChange={(e) => setStored(e.target.checked)}
        />
      </div>
    </Dialog>
  );
}
