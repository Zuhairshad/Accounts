"use client";

import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ArrowDownUp, FileText } from "lucide-react";
import { displayDate } from "@/lib/validation";

type Row = { id: string; number: string | null; date: string; type: string; narration: string };
const columns: ColumnDef<Row>[] = [
  { accessorKey: "date", header: "Date", cell: ({ row }) => displayDate(row.original.date) },
  { accessorKey: "number", header: "Voucher no." },
  { accessorKey: "type", header: "Type", cell: ({ row }) => row.original.type.replaceAll("_", " ") },
  { accessorKey: "narration", header: "Description" },
];

export function LedgerTable({ data }: { data: Row[] }) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  if (!data.length) return <div className="table-empty acc-empty"><FileText size={22} aria-hidden /><strong>No posted vouchers in this period</strong><p>Posted entries appear here once they are recorded.</p></div>;
  return <div className="table-scroll acc-sheet">
    <table className="activity-table acc-table">
      <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id} scope="col"
        aria-sort={header.column.getIsSorted() === "asc" ? "ascending" : header.column.getIsSorted() === "desc" ? "descending" : "none"}>
        <button type="button" className="acc-sort" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}<ArrowDownUp size={13} /></button>
      </th>)}</tr>)}</thead>
      <tbody>{table.getRowModel().rows.map((row) => <tr key={row.original.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}
