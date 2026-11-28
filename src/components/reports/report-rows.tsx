"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { showCell, type ReportRow } from "@/lib/reports/model";

/** Table body for on-screen reports. Heading rows with a `toggle` collapse and expand the rows that name them as `parent`. */
export function ReportRows({ columns, rows }: { columns: number; rows: ReportRow[] }) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const flip = (key: string) => setClosed((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  return <tbody>{rows.map((row, index) => row.parent && closed.has(row.parent) ? null : <tr key={row.key}
    className={row.style ? `report-row-${row.style}` : undefined}
    data-voucher-start={row.group && row.group !== rows[index-1]?.group ? "true" : undefined}>
    {Array.from({ length: columns }, (_, i) => {
      const cell = row.cells[i];
      const numeric = cell && ["money","quantity","integer"].includes(cell.kind ?? "");
      // The first non-empty text cell of a heading row becomes its expand and collapse control.
      const control = row.toggle && cell && !numeric && cell.value && row.cells.findIndex((c) => c.value && !c.kind) === i;
      if (control) {
        const open = !closed.has(row.toggle!);
        return <td key={i}><button type="button" className="report-toggle" aria-expanded={open} onClick={() => flip(row.toggle!)}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}{showCell(cell)}
        </button></td>;
      }
      return <td key={i} className={numeric ? "report-number" : undefined}>
        {cell?.href ? <Link href={cell.href} className="text-link">{showCell(cell)}</Link> : cell ? showCell(cell) : ""}
      </td>;
    })}
  </tr>)}</tbody>;
}
