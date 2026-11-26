import { z } from "zod";
import { karachiToday } from "./validation";

const isoDate = z.iso.date();
export type Query = Record<string, string | string[] | undefined>;
export const first = (value: Query[string]) => Array.isArray(value) ? value[0] : value;

export function resolveRange(params: Query, year?: { startsOn: string; endsOn: string }) {
  const today = karachiToday();
  const defaults = { from: year?.startsOn ?? `${today.slice(0, 7)}-01`, to: year?.endsOn ?? today };
  const from = first(params.from) || defaults.from;
  const to = first(params.to) || defaults.to;
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success || from > to ||
      (year && (from < year.startsOn || to > year.endsOn))) {
    return { ...defaults, error: "Choose a valid date range within the selected financial year." };
  }
  return { from, to, error: null };
}
