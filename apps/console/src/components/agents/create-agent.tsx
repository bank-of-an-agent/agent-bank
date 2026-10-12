"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextAreaField, TextField } from "@/components/ui/field";
import { IconPlus } from "@/components/ui/icons";
import { ProblemAlert } from "@/components/ui/problem-alert";
import { useToast } from "@/components/ui/toast";
import { apiFetch, useIdempotencyKey, useMutation } from "@/lib/api/hooks";

export function CreateAgentButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} icon={<IconPlus size={16} />} onClick={() => setOpen(true)}>
        Create agent
      </Button>
      <CreateAgentDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CreateAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [erc8004, setErc8004] = useState("");
  const [cardUrl, setCardUrl] = useState("");
  const [key, rotate] = useIdempotencyKey();
  const create = useMutation(
    () =>
      apiFetch("createAgent", {
        body: {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(erc8004.trim() ? { erc8004_id: erc8004.trim() } : {}),
          ...(cardUrl.trim() ? { agent_card_url: cardUrl.trim() } : {}),
        },
        idempotencyKey: key,
      }),
    { invalidates: ["listAgents"] },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await create.run();
    if (!result.ok) return;
    rotate();
    toast({ title: `${result.data.name} created`, description: "Next: create its smart account." });
    onClose();
    router.push(`/agents/${result.data.id}`);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create an agent"
      description="An agent is a software identity that acts for your org. It gets its own smart account and limits."
      dismissible={!create.pending}
    >
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <TextAreaField
          label="Description"
          rows={2}
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextField
          label="ERC-8004 agent id"
          hint="Optional on-chain identity, e.g. eip155:84532:0x…:42"
          maxLength={200}
          value={erc8004}
          onChange={(e) => setErc8004(e.target.value)}
        />
        <TextField
          label="Agent card URL"
          type="url"
          hint="Optional. Where the agent publishes its endpoints."
          value={cardUrl}
          onChange={(e) => setCardUrl(e.target.value)}
        />
        {create.error ? <ProblemAlert problem={create.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.pending} disabled={!name.trim()}>
            Create agent
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
