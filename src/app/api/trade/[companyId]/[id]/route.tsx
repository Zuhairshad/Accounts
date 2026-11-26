import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { z } from "zod";
import { getDb } from "@/db";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany } from "@/lib/companies";
import { formatMoney } from "@/lib/display";
import { displayDate } from "@/lib/validation";
import { Exact } from "@/lib/engine/model";
import { invoiceDetail, tradeOptions } from "@/lib/trade/read";
import { invoiceSchema, tradeNames, type InvoiceCalculation } from "@/lib/trade/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const styles = StyleSheet.create({
  page: { padding: 34, fontSize: 9, color: "#14213a" },
  company: { fontSize: 13, color: "#154dac", marginBottom: 7 },
  title: { fontSize: 21, marginBottom: 9, fontWeight: 700 },
  meta: { marginBottom: 5, lineHeight: 1.2 },
  table: { marginTop: 13, borderTop: "1 solid #cfd8e7" },
  row: { flexDirection: "row", borderBottom: "1 solid #cfd8e7", paddingVertical: 6 },
  top: { backgroundColor: "#eef3fb", fontWeight: 700 },
  desc: { width: "34%", paddingHorizontal: 4 },
  amount: { width: "13.2%", textAlign: "right", paddingHorizontal: 4 },
  totals: { marginTop: 13, lineHeight: 1.5 },
});

export async function GET(request: Request, { params }: { params: Promise<{ companyId: string; id: string }> }) {
  const { companyId, id } = await params;
  const actor = await getActor();
  if (!actor || !z.uuid().safeParse(companyId).success || !z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  try {
    const company = await requireCompany(actor, companyId, "view");
    if (!company.permissions.includes(inline ? "print" : "export")) return new Response(null, { status: 404 });
    const db = getDb();
    const data = await invoiceDetail(db, companyId, id);
    if (!data) return new Response(null, { status: 404 });
    const { invoice, party, voucher, original, exchange, payments } = data;
    const calc = invoice.calculation as InvoiceCalculation | null;
    const payload = invoiceSchema.safeParse(invoice.payload);
    const options = payload.success && !data.lines.length ? await tradeOptions(db, companyId) : null;
    const lines = data.lines.length ? data.lines : payload.success ? payload.data.lines.map((line, index) => ({
      lineNo: index+1, item: options?.goods.find((item) => item.id === line.itemId)?.name ?? "Item", description: line.description,
      qty: line.quantity, unit: options?.goods.find((item) => item.id === line.itemId)?.unit ?? "", rate: line.rate,
      discount: line.discount, tax: line.tax, amount: null, disposition: line.disposition,
    })) : [];
    const title = invoice.number ?? `${tradeNames[invoice.type]} draft`;
    const buffer = await renderToBuffer(<Document title={title} author={company.name}><Page size="A4" style={styles.page}>
      <Text style={styles.company}>{company.name}</Text><Text style={styles.title}>{title}</Text>
      <Text style={styles.meta}>{tradeNames[invoice.type]} · {displayDate(invoice.date)} · {invoice.status.toUpperCase()}</Text>
      <Text style={styles.meta}>Party {party?.name ?? "—"} · Voucher {voucher?.number ?? "Unposted"}</Text>
      <Text style={styles.meta}>Ref {invoice.externalRef || "—"} · PO {invoice.poRef || "—"} · Due {invoice.dueOn ? displayDate(invoice.dueOn) : "—"}</Text>
      {original && <Text style={styles.meta}>Original invoice {original.number}</Text>}{exchange && <Text style={styles.meta}>Exchange return {exchange.number}</Text>}
      {payload.success && <><Text style={styles.meta}>{payload.data.narration || tradeNames[invoice.type]}</Text>
        {payload.data.reason && <Text style={styles.meta}>Reason {payload.data.reason}</Text>}
        {payload.data.notes && <Text style={styles.meta}>Notes {payload.data.notes}</Text>}</>}
      <View style={styles.table}>
        <View style={[styles.row,styles.top]} fixed><Text style={styles.desc}>Item and description</Text>
          {["Qty","Rate","Discount","Tax","Total"].map((header) => <Text key={header} style={styles.amount}>{header}</Text>)}</View>
        {lines.map((line) => <View key={line.lineNo} style={styles.row} wrap={false}>
          <Text style={styles.desc}>{line.item} {line.description && line.description !== line.item ? `· ${line.description}` : ""}
            {invoice.type === "sale_return" ? ` · ${line.disposition}` : ""}</Text>
          <Text style={styles.amount}>{new Exact(line.qty).toString()} {line.unit}</Text><Text style={styles.amount}>{new Exact(line.rate).toString()}</Text>
          <Text style={styles.amount}>{formatMoney(line.discount)}</Text><Text style={styles.amount}>{formatMoney(line.tax)}</Text>
          <Text style={styles.amount}>{line.amount === null ? "Draft" : formatMoney(line.amount)}</Text>
        </View>)}
      </View>
      {invoice.voucherId && <View style={styles.totals} wrap={false}>
        <Text>Grand total PKR {formatMoney(invoice.total)}</Text>
        {calc && <><Text>On party account PKR {formatMoney(calc.partyAmount)}</Text>
          <Text>Paid or refunded PKR {formatMoney(calc.settled)} · Withholding PKR {formatMoney(calc.withholding)}</Text></>}
        {payments.map((payment, i) => <Text key={i}>{payment.name} PKR {formatMoney(payment.amount)}</Text>)}
      </View>}
    </Page></Document>);
    const filename = title.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0,120);
    return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}.pdf"` } });
  } catch (error) {
    if (error instanceof AccessError) return new Response(null, { status: 404 });
    console.error("Invoice PDF generation failed");
    return new Response("Invoice PDF is temporarily unavailable.", { status: 503 });
  }
}
