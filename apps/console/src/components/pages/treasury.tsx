"use client";

import { TopUpRulesCard } from "@/components/treasury/topup-table";
import { TreasuryAccountCard } from "@/components/treasury/treasury-account";
import { TreasurySweepCard } from "@/components/treasury/sweep";
import { VaultsCard } from "@/components/treasury/vaults";
import { PageHeader } from "@/components/ui/layout";

export function TreasuryPage() {
  return (
    <>
      <PageHeader
        title="Treasury"
        description="Savings stay in your own smart accounts or a fund you pick. Agent Bank never pools deposits and never pays interest itself."
      />
      <div className="space-y-6">
        <TreasuryAccountCard />
        <TopUpRulesCard />
        <VaultsCard />
        <TreasurySweepCard />
      </div>
    </>
  );
}
