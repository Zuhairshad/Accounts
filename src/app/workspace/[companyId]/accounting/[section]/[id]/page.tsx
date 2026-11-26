import { notFound } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { accountingAccess } from "@/lib/engine/access";
import { readVoucher } from "@/lib/engine/read";
import { AccountDetail, LedgerDetail, PartyDetail, PartySettlement, VoucherDetail, VoucherEntry } from "@/components/accounting/detail-views";
import type { Screen } from "@/components/accounting/index-views";
import { first, type Query } from "@/lib/range";

export default async function AccountingDetail({ params, searchParams }: {
  params: Promise<{ companyId: string; section: string; id: string }>; searchParams: Promise<Query>;
}) {
  const { companyId, section, id } = await params;
  const { company, base, actor } = await accountingAccess(companyId);
  const query = await searchParams;
  const screen: Screen = { companyId, base, companyName: company.name, permissions: company.permissions, query, actorId: actor.id };
  if (id !== "new" && !z.uuid().safeParse(id).success) notFound();
  let view: React.ReactNode;
  if (section === "vouchers") {
    if (id === "new") {
      const copy = first(query.copy);
      if (copy && !z.uuid().safeParse(copy).success) notFound();
      view = await VoucherEntry(screen, undefined, copy);
    } else if (first(query.edit) === "1") view = await VoucherEntry(screen, id);
    else {
      const voucher = await readVoucher(getDb(), companyId, id);
      if (!voucher) notFound();
      view = await VoucherDetail(screen, voucher);
    }
  } else if (section === "chart") view = await AccountDetail(screen, id === "new" ? undefined : id);
  else if (section === "parties") view = await PartyDetail(screen, id === "new" ? undefined : id);
  else if (section === "ledger" && id !== "new") view = await LedgerDetail(screen, id, "account");
  else if (section === "party-ledger" && id !== "new") view = await LedgerDetail(screen, id, "party");
  else if (section === "allocations" && id !== "new") view = await PartySettlement(screen, id);
  else notFound();
  return <div className="page-stack">{view}</div>;
}
