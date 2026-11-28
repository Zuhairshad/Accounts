import { notFound } from "next/navigation";
import { accountingAccess } from "@/lib/engine/access";
import { AdjustmentRegister, InventoryView, TradeRegister, TradeSettings, type TradeScreen } from "@/components/trade/views";
import type { Query } from "@/lib/range";

export default async function TradeSection({ params, searchParams }: {
  params: Promise<{ companyId: string; section: string }>; searchParams: Promise<Query>;
}) {
  const { companyId, section } = await params;
  const access = await accountingAccess(companyId);
  const screen: TradeScreen = {
    companyId, company: access.company.name, base: `/workspace/${companyId}/trade`, accounting: access.base,
    permissions: access.company.permissions, query: await searchParams,
  };
  const views = { invoices: TradeRegister, inventory: InventoryView, adjustments: AdjustmentRegister, settings: TradeSettings };
  if (!Object.hasOwn(views, section)) notFound();
  return <div className="page-stack trade-page">{await views[section as keyof typeof views](screen)}</div>;
}
