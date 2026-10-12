"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import type { ResponseOf } from "@agentbank/core/api";
import { Amount, DateTimeValue, IdValue } from "@/components/ui/values";
import { humanize } from "@/lib/format";
import { tryMinor } from "@/lib/money";

export type LedgerEntry = ResponseOf<"listEntries">["data"][number];

/** Pockets are account-scoped ledger accounts; `sys:*` are Agent Bank's system accounts. */
export function LedgerAccountLabel({ code }: { code: string }) {
  if (code.startsWith("sys:")) return <Badge tone="violet">{code}</Badge>;
  const pocket = code.replace(/^pocket:/, "");
  return <Badge tone="neutral">{humanize(pocket)}</Badge>;
}

/** Journal entries with their balanced lines (each entry sums to zero). */
export function EntriesTable({
  entries,
  caption = "Ledger entries",
}: {
  entries: LedgerEntry[];
  caption?: string;
}) {
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <Th>Entry</Th>
          <Th>Reason</Th>
          <Th>Lines</Th>
          <Th>Created</Th>
        </tr>
      </THead>
      <tbody>
        {entries.map((entry) => (
          <Tr key={entry.id}>
            <Td>
              <IdValue value={entry.id} />
              {entry.reverses_entry_id ? (
                <p className="mt-1 text-xs text-warn-fg">
                  Reverses <code className="font-mono">{entry.reverses_entry_id}</code>
                </p>
              ) : null}
            </Td>
            <Td>
              <p className="font-medium">{humanize(entry.ref_type)}</p>
              {entry.memo ? <p className="text-xs text-muted">{entry.memo}</p> : null}
              {entry.payment_id ? (
                <Link href={`/payments/${entry.payment_id}`} className="text-xs text-blue-fg hover:underline">
                  Payment
                </Link>
              ) : null}
            </Td>
            <Td>
              <ul className="space-y-1">
                {entry.lines.map((line, i) => {
                  const minor = tryMinor(line.amount, line.asset);
                  return (
                    <li
                      key={`${line.ledger_account}-${i}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4"
                    >
                      <LedgerAccountLabel code={line.ledger_account} />
                      <Amount
                        value={line.amount}
                        asset={line.asset}
                        signed
                        className={minor !== null && minor < 0n ? "text-danger-fg" : "text-teal-fg"}
                      />
                    </li>
                  );
                })}
              </ul>
            </Td>
            <Td className="text-muted">
              <DateTimeValue value={entry.created_at} />
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
