"use client";

import Link from "next/link";
import { StatusBadge } from "@/components/ui/badge";
import { Table, Td, Th, THead, Tr } from "@/components/ui/table";
import { DateTimeValue, MoneyValue } from "@/components/ui/values";
import { accountLabel, type Account, type Agent, type Payment } from "@/lib/api/queries";
import { CounterpartyLabel, kindLabel } from "./payment-bits";

export function PaymentsTable({
  payments,
  agents,
  accounts,
  caption = "Payments",
  showAccount = true,
}: {
  payments: Payment[];
  agents: Map<string, Agent>;
  accounts: Map<string, Account>;
  caption?: string;
  showAccount?: boolean;
}) {
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <Th>Payment</Th>
          {showAccount ? <Th>From</Th> : null}
          <Th>Counterparty</Th>
          <Th align="right">Amount</Th>
          <Th align="right">Fee</Th>
          <Th>Status</Th>
          <Th>Created</Th>
        </tr>
      </THead>
      <tbody>
        {payments.map((payment) => {
          const account = accounts.get(payment.account_id);
          return (
            <Tr key={payment.id}>
              <Td>
                <Link href={`/payments/${payment.id}`} className="font-medium text-blue-fg hover:underline">
                  {kindLabel(payment.kind)}
                </Link>
                <p className="font-mono text-xs text-muted">{payment.id.slice(0, 12)}…</p>
                {payment.memo ? (
                  <p className="max-w-[14rem] truncate text-xs text-muted">{payment.memo}</p>
                ) : null}
              </Td>
              {showAccount ? (
                <Td>
                  {account?.agent_id ? (
                    <Link href={`/agents/${account.agent_id}`} className="hover:underline">
                      {accountLabel(account, agents)}
                    </Link>
                  ) : (
                    accountLabel(account, agents)
                  )}
                </Td>
              ) : null}
              <Td>
                <CounterpartyLabel
                  counterparty={payment.counterparty}
                  agents={agents}
                  chain={account?.chain}
                />
              </Td>
              <Td align="right">
                <MoneyValue money={payment.amount} />
              </Td>
              <Td align="right" className="text-muted">
                <MoneyValue money={payment.fee} />
              </Td>
              <Td>
                <StatusBadge status={payment.status} />
              </Td>
              <Td className="text-muted">
                <DateTimeValue value={payment.created_at} />
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}
