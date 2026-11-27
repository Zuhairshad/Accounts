import Link from "next/link";
import { formatMoney } from "@/lib/display";

const pkr = (value: string) => `PKR ${formatMoney(value)}`;

/** Month-end balances as small bars; the latest month is emphasised. Each bar has a native hover title. */
export function MiniBars({ points }: { points: { label: string; value: string }[] }) {
  // Bars show size; a negative month-end balance is drawn in a muted tone so it is never mistaken for a positive one.
  const values = points.map((p) => Math.abs(Number(p.value)));
  const max = Math.max(...values, 1);
  const width = 120, height = 44, bar = 10, gap = (width - bar * points.length) / Math.max(points.length - 1, 1);
  return <svg className="mini-bars" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img"
    aria-label={`Month-end balance: ${points.map((p) => `${p.label} ${pkr(p.value)}`).join(", ")}`}>
    {points.map((p, i) => {
      const h = Math.max(3, (values[i] / max) * (height - 4));
      return <g key={p.label}><title>{`${p.label}: ${pkr(p.value)}`}</title>
        <path d={`M${i * (bar + gap)},${height} v${-(h - 4)} q0,-4 4,-4 h${bar - 8} q4,0 4,4 v${h - 4} z`}
          className={[i === points.length - 1 ? "current" : "", Number(p.value) < 0 ? "negative" : ""].join(" ")} /></g>;
    })}
  </svg>;
}

/** Single-value ring (e.g. gross margin). A null value renders an explicit "no sales" state rather than 0%. */
export function Ring({ value, label }: { value: number | null; label: string }) {
  const r = 38, c = 2 * Math.PI * r;
  const share = value === null ? 0 : Math.max(0, Math.min(100, value));
  return <svg className="kpi-ring" viewBox="0 0 96 96" width="112" height="112" role="img" aria-label={`${label}: ${value === null ? "no sales in period" : `${value}%`}`}>
    <circle cx="48" cy="48" r={r} className="ring-track" />
    {value !== null && <circle cx="48" cy="48" r={r} className="ring-value" strokeDasharray={`${(share / 100) * c} ${c}`} transform="rotate(-90 48 48)" />}
    <text x="48" y="54" textAnchor="middle">{value === null ? "—" : `${value}%`}</text>
  </svg>;
}

// Sequential single-hue ramp (light → dark) for ordered age bands.
const agingRamp = ["#a9d0f7", "#6aacee", "#257de0", "#1b5fb0", "#123f78"];

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

/** Month grid of posting days. Each day with postings links to that day's voucher register. */
export function PostingCalendar({ month, days, today, base }: { month: string; days: Record<string, number>; today: string; base: string }) {
  const first = new Date(`${month}T00:00:00Z`);
  const year = first.getUTCFullYear(), m = first.getUTCMonth();
  const length = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length }, (_, i) => `${month.slice(0, 8)}${String(i + 1).padStart(2, "0")}`)];
  const title = first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return <div className="calendar">
    <div className="calendar-head"><strong>{title}</strong><span>{Object.values(days).reduce((a, b) => a + b, 0)} postings</span></div>
    <div className="calendar-grid" role="grid" aria-label={`Posting days in ${title}`}>
      {weekdays.map((w) => <span key={w} className="calendar-weekday" role="columnheader">{w}</span>)}
      {cells.map((day, i) => {
        if (!day) return <span key={`blank-${i}`} />;
        const count = days[day] ?? 0;
        const label = `${Number(day.slice(8))}`;
        const classes = ["calendar-day", count ? "has-postings" : "", day === today ? "today" : ""].join(" ");
        return count ? <Link key={day} href={`${base}/reports/voucher-register?from=${day}&to=${day}`} className={classes} role="gridcell"
          title={`${count} posting${count === 1 ? "" : "s"} on ${day.split("-").reverse().join("-")}`}>{label}</Link>
          : <span key={day} className={classes} role="gridcell">{label}</span>;
      })}
    </div>
  </div>;
}
