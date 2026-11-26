import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { z } from "zod";
import { getDb } from "@/db";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany } from "@/lib/companies";
import { journalSelectors, readVoucher } from "@/lib/engine/read";
import { Exact, manualVoucher } from "@/lib/engine/model";
import { formatMoney } from "@/lib/display";
import { displayDate, karachiToday } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const styles = StyleSheet.create({
  page: { padding: 34, fontSize: 9, color: "#14213a" },
  head: { fontSize: 13, color: "#154dac", marginBottom: 9 },
  title: { fontSize: 22, marginBottom: 10, fontWeight: 700 },
  meta: { marginBottom: 5, lineHeight: 1.3 },
  table: { marginTop: 14, borderTop: "1 solid #cfd8e7" },
  row: { flexDirection: "row", borderBottom: "1 solid #cfd8e7", paddingVertical: 6 },
  header: { backgroundColor: "#eef3fb", fontWeight: 700 },
  main: { width: "29%", paddingHorizontal: 3 },
  detail: { width: "37%", paddingHorizontal: 3 },
  number: { width: "17%", textAlign: "right", paddingHorizontal: 3 },
  footer: { marginTop: 12, color: "#52627a" },
});

export async function GET(request: Request, { params }: { params: Promise<{ companyId: string; id: string }> }) {
  const { companyId, id } = await params;
  const actor = await getActor();
  if (!actor || !z.uuid().safeParse(companyId).success || !z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  try {
    const company = await requireCompany(actor, companyId, "view");
    if (!company.permissions.includes(inline ? "print" : "export")) return new Response(null, { status: 404 });
    const voucher = await readVoucher(getDb(), companyId, id);
    if (!voucher) return new Response(null, { status: 404 });
    const draft = manualVoucher.safeParse((voucher.doc?.draft as { entry?: unknown } | undefined)?.entry);
    const options = draft.success ? await journalSelectors(getDb(), companyId, karachiToday()) : [];
    const lines = voucher.postedLines.length ? voucher.postedLines : draft.success ? draft.data.lines.map((line) => ({
      ...line, account: options.find((item) => item.accountId === line.accountId && item.partyId === line.partyId)?.label ?? "Account", party: null,
    })) : [];
    const total = (side: "debit" | "credit") => lines.reduce((value, line) => value.plus(line[side]), new Exact(0)).toFixed(2);
    const title = voucher.number ?? `${voucher.type} draft`;
    const pdf = await renderToBuffer(<Document title={title} author={company.name}><Page size="A4" style={styles.page}>
      <Text style={styles.head}>{company.name}</Text><Text style={styles.title}>{title}</Text>
      <Text style={styles.meta}>{voucher.type} · {displayDate(voucher.date)} · {voucher.status.toUpperCase()}</Text>
      <Text style={styles.meta}>Reference {voucher.reference || "—"}</Text>
      <Text style={styles.meta}>{draft.success ? draft.data.narration : voucher.narration}</Text>
      <View style={styles.table}>
        <View style={[styles.row, styles.header]} fixed><Text style={styles.main}>Account / party</Text><Text style={styles.detail}>Description</Text>
          <Text style={styles.number}>Debit (PKR)</Text><Text style={styles.number}>Credit (PKR)</Text></View>
        {lines.map((line, index) => <View key={index} style={styles.row} wrap={false}>
          <Text style={styles.main}>{line.account}{line.party ? ` / ${line.party}` : ""}</Text><Text style={styles.detail}>{line.description}</Text>
          <Text style={styles.number}>{formatMoney(line.debit)}</Text><Text style={styles.number}>{formatMoney(line.credit)}</Text>
        </View>)}
        <View style={[styles.row, styles.header]} wrap={false}><Text style={styles.main}>Totals</Text><Text style={styles.detail} />
          <Text style={styles.number}>{formatMoney(total("debit"))}</Text><Text style={styles.number}>{formatMoney(total("credit"))}</Text></View>
      </View>
      <Text style={styles.footer}>AZAM EASY ACCOUNTS V4.0</Text>
    </Page></Document>);
    const filename = title.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120);
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}.pdf"`,
        "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AccessError) return new Response(null, { status: 404 });
    console.error("Voucher PDF generation failed");
    return new Response("Voucher PDF is temporarily unavailable.", { status: 503 });
  }
}
