import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatMoney } from "@/lib/display";

const pkr = (value: string) => `PKR ${formatMoney(value)}`;

// Ordered age bands: green while current, warming to red as invoices age.
const agingRamp = ["#4caf6e", "#c9a227", "#e8873a", "#d9534f", "#9b2226"];

export function AgingDonut({ bands }: { bands: { key: string; label: string; amount: string; count: number }[] }) {
  const total = bands.reduce((sum, b) => sum + Number(b.amount), 0);
  const r = 44, c = 2 * Math.PI * r;
  let offset = 0;
  return <div className="aging">
    <svg viewBox="0 0 120 120" width="132" height="132" role="img" aria-label="Receivables by age band; amounts are listed beside the chart.">
      <circle cx="60" cy="60" r={r} className="ring-track" />
      {total > 0 && bands.map((band, i) => {
        const length = (Number(band.amount) / total) * c;
        if (length <= 0) return null;
        // A 2px surface gap separates adjacent segments.
        const segment = <circle key={band.key} cx="60" cy="60" r={r} fill="none" stroke={agingRamp[i]} strokeWidth="14"
          strokeDasharray={`${Math.max(length - 2, 0.5)} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)">
          <title>{`${band.label}: ${pkr(band.amount)} (${band.count} invoices)`}</title></circle>;
        offset += length;
        return segment;
      })}
      <text x="60" y="56" textAnchor="middle" className="donut-caption">Open</text>
      <text x="60" y="74" textAnchor="middle" className="donut-total">{bands.reduce((n, b) => n + b.count, 0)}</text>
    </svg>
    <ul className="aging-legend">{bands.map((band, i) => <li key={band.key}>
      <i style={{ background: agingRamp[i] }} /><span>{band.label}</span><b>{formatMoney(band.amount)}</b>
    </li>)}</ul>
  </div>;
}

const weekdays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Month grid of posting days with the neighbouring months' days greyed in. Days with postings are ringed and link to that
 * day's voucher register; today is filled.
 */
export function MonthCalendar({ month, days, today, base, previous, next }: {
  month: string; days: Record<string, number>; today: string; base: string; previous: string; next: string;
}) {
  const start = new Date(`${month}T00:00:00Z`);
  const lead = (start.getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const total = Math.ceil((lead + length) / 7) * 7;
  const cells = Array.from({ length: total }, (_, i) => isoDay(new Date(start.getTime() + (i - lead) * 86_400_000)));
  const title = start.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const postings = Object.values(days).reduce((a, b) => a + b, 0);
  return <div className="month-calendar">
    <div className="calendar-head"><h2>{title}</h2>
      <span className="calendar-nav"><Link href={previous} aria-label="Previous month" scroll={false}><ChevronLeft size={16} /></Link>
        <Link href={next} aria-label="Next month" scroll={false}><ChevronRight size={16} /></Link></span></div>
    <div className="calendar-grid" role="grid" aria-label={`${postings} posting${postings === 1 ? "" : "s"} in ${title}`}>
      {weekdays.map((w) => <span key={w} className="calendar-weekday" role="columnheader">{w}</span>)}
      {cells.map((day) => {
        const inMonth = day.slice(0, 7) === month.slice(0, 7);
        const count = inMonth ? days[day] ?? 0 : 0;
        const classes = ["calendar-day", inMonth ? "" : "outside", count ? "has-postings" : "", day === today ? "today" : ""].join(" ");
        const label = String(Number(day.slice(8)));
        return count ? <Link key={day} href={`${base}/reports/voucher-register?from=${day}&to=${day}`} className={classes} role="gridcell"
          title={`${count} posting${count === 1 ? "" : "s"} on ${day.split("-").reverse().join("-")}`}>{label}</Link>
          : <span key={day} className={classes} role="gridcell">{label}</span>;
      })}
    </div>
  </div>;
}
