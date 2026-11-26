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
  return <div className="table-scroll">
    <table>
      <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id} scope="col"
        aria-sort={header.column.getIsSorted() === "asc" ? "ascending" : header.column.getIsSorted() === "desc" ? "descending" : "none"}>
        <button type="button" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}<ArrowDownUp size={13} /></button>
      </th>)}</tr>)}</thead>
      <tbody>{table.getRowModel().rows.map((row) => <tr key={row.original.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody>
    </table>
    {!data.length && <div className="empty"><span className="empty-icon"><FileText size={24} /></span><strong>No posted vouchers in this period</strong><p>Posted entries appear here once they are recorded.</p></div>}
  </div>;
}
