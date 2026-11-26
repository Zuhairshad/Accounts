import { notFound } from "next/navigation";
import { accountingAccess } from "@/lib/engine/access";
import { AccountingSettings, ChartIndex, OpeningIndex, PartyIndex, PartyReports, Recycling, VoucherRegister, type Screen } from "@/components/accounting/index-views";
import { LegacyRepairs } from "@/components/accounting/legacy-repairs";
import type { Query } from "@/lib/range";

export default async function AccountingSection({ params, searchParams }: {
  params: Promise<{ companyId: string; section: string }>; searchParams: Promise<Query>;
}) {
  const { companyId, section } = await params;
  const { company, base, actor } = await accountingAccess(companyId);
  const screen: Screen = { companyId, base, companyName: company.name, permissions: company.permissions, query: await searchParams, actorId: actor.id };
  const views: Record<string, () => Promise<React.ReactNode>> = {
    vouchers: () => VoucherRegister(screen), chart: () => ChartIndex(screen), ledger: () => ChartIndex(screen),
    parties: () => PartyIndex(screen), "party-ledger": () => PartyIndex(screen), allocations: () => PartyIndex(screen), opening: () => OpeningIndex(screen),
    debtors: () => PartyReports(screen, "customer"), creditors: () => PartyReports(screen, "supplier"),
    recycle: () => Recycling(screen), settings: () => AccountingSettings(screen), repair: () => LegacyRepairs(screen),
  };
  if (!Object.hasOwn(views, section)) notFound();
  return <div className="page-stack">{await views[section]()}</div>;
}
