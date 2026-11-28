"use client";

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import type { MonthPoint } from "@/lib/dashboard";

// Theme colours: brand green for sales, dark slate for purchases and blue for the profit line, so each stays distinct.
const series = [
  { key: "sales", label: "Net sales", color: "#2f8f4e" },
  { key: "purchases", label: "Purchases", color: "#1d2733" },
  { key: "profit", label: "Net profit", color: "#2563eb" },
] as const;

const compact = new Intl.NumberFormat("en-PK", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Tip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tip" role="status">
    <strong>{label}</strong>
    {series.map((s) => {
      const point = payload.find((p) => p.dataKey === s.key);
      return point ? <div key={s.key}><i style={{ background: s.color }} />{s.label}<b>PKR {full.format(Number(point.value))}</b></div> : null;
    })}
  </div>;
}

export function OverviewChart({ data }: { data: MonthPoint[] }) {
  const rows = data.map((row) => ({ label: row.label, sales: Number(row.sales), purchases: Number(row.purchases), profit: Number(row.profit) }));
  const empty = rows.every((row) => !row.sales && !row.purchases && !row.profit);
  return <div className="overview-chart">
    <ul className="chart-legend" aria-label="Chart legend">
      {series.map((s) => <li key={s.key}><i className={s.key === "profit" ? "line" : ""} style={{ background: s.color }} />{s.label}</li>)}
    </ul>
    {empty ? <p className="chart-empty">No posted sales, purchases or results in these months.</p> :
      <div className="chart-box" role="img" aria-label="Monthly net sales, purchases and net profit in PKR. A table with the same figures follows.">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="#eef0f3" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "#e5e7eb" }} tick={{ fill: "#6b7280", fontSize: 12 }} />
            <YAxis tickLine={false} axisLine={false} width={56} tick={{ fill: "#6b7280", fontSize: 12 }} tickFormatter={(v: number) => compact.format(v)} />
            <Tooltip content={Tip} cursor={{ fill: "rgba(47,143,78,.06)" }} />
            <Bar dataKey="sales" name="Net sales" fill={series[0].color} maxBarSize={18} radius={[4, 4, 0, 0]} />
            <Bar dataKey="purchases" name="Purchases" fill={series[1].color} maxBarSize={18} radius={[4, 4, 0, 0]} />
            <Line dataKey="profit" name="Net profit" stroke={series[2].color} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: "#fff", fill: series[2].color }}
              activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>}
    <details className="chart-table">
      <summary>View as table</summary>
      <div className="table-scroll"><table>
        <thead><tr><th scope="col">Month</th>{series.map((s) => <th key={s.key} scope="col" className="money-cell">{s.label} (PKR)</th>)}</tr></thead>
        <tbody>{data.map((row) => <tr key={row.month}><td>{row.label}</td>
          {series.map((s) => <td key={s.key} className="money-cell">{full.format(Number(row[s.key]))}</td>)}</tr>)}</tbody>
      </table></div>
    </details>
  </div>;
}
