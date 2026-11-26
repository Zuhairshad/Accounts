import { notFound } from "next/navigation";
import { z } from "zod";
import { accountingAccess } from "@/lib/engine/access";
import { AdjustmentView, ItemView, TradeDetail, TradeEntry, type TradeScreen } from "@/components/trade/views";
import { first, type Query } from "@/lib/range";

export default async function TradeRecord({ params, searchParams }: {
  params: Promise<{ companyId: string; section: string; id: string }>; searchParams: Promise<Query>;
}) {
  const { companyId, section, id } = await params;
  const access = await accountingAccess(companyId);
  const query = await searchParams;
  const screen: TradeScreen = { companyId, company: access.company.name, base: `/workspace/${companyId}/trade`,
    accounting: access.base, permissions: access.company.permissions, query };
  if (id !== "new" && !z.uuid().safeParse(id).success) notFound();
  let view;
  if (section === "invoices") view = id === "new" || first(query.edit) === "1" ? await TradeEntry(screen, id === "new" ? undefined : id) : await TradeDetail(screen, id);
  else if (section === "inventory") view = await ItemView(screen, id === "new" ? undefined : id);
  else if (section === "adjustments") view = await AdjustmentView(screen, id === "new" ? undefined : id);
  else notFound();
  return <div className="page-stack">{view}</div>;
}
