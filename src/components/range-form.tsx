"use client";

import { useState } from "react";
import { CalendarDays, ChevronDown, Filter } from "lucide-react";
import { Button } from "./ui/button";

type Year = { id: string; name: string; startsOn: string; endsOn: string };

export function RangeForm({ years, current, range }: { years?: Year[]; current?: string; range: { from: string; to: string } }) {
  const [selection, setSelection] = useState(current ?? "");
  const [dates, setDates] = useState(range);

  return <form className="range-form panel" method="get">
    <div className="range-title"><CalendarDays size={20} /><strong>Reporting period</strong></div>
    {years && <label className="field">Financial year<span className="select-wrap"><select name="year" value={selection} onChange={(event) => {
      const id = event.target.value;
      setSelection(id);
      const year = years.find((entry) => entry.id === id);
      if (year) setDates({ from: year.startsOn, to: year.endsOn });
    }}><option value="">Custom range</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select><ChevronDown size={15} /></span></label>}
    <label className="field">From<input type="date" name="from" required value={dates.from} onChange={(event) => setDates({ ...dates, from: event.target.value })} /></label>
    <label className="field">To<input type="date" name="to" required value={dates.to} onChange={(event) => setDates({ ...dates, to: event.target.value })} /></label>
    <Button type="submit" variant="outline"><Filter size={16} /> Apply filters</Button>
  </form>;
}
