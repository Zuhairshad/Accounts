import { z } from "zod";
import { permissions } from "./permissions";

export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.@+-]{2,119}$/, "Enter a valid username.");
export const passwordSchema = z.string().min(15, "Use at least 15 characters.").max(128, "Use at most 128 characters.");
export const displayNameSchema = z.string().trim().min(1).max(120);
export const versionSchema = z.coerce.number().int().positive();
export const companyNameSchema = z.string().trim().min(1).max(160);
export const companySettingsSchema = z.object({
  name: companyNameSchema,
  logoUrl: z.union([z.literal(""), z.url({ protocol: /^https$/ }).max(500)]),
  address: z.string().trim().max(500),
  phone: z.string().trim().max(60),
  email: z.union([z.literal(""), z.email().max(200)]),
  ntn: z.string().trim().max(60),
  strn: z.string().trim().max(60),
  numberPrefix: z.string().trim().regex(/^[A-Za-z0-9/-]{0,24}$/, "Use letters, digits, slash or hyphen."),
  numberPadding: z.coerce.number().int().min(1).max(10),
});

export const financialYearSchema = z.object({
  name: z.string().trim().min(1).max(80),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
}).refine((year) => year.startsOn <= year.endsOn && year.startsOn >= "1900-01-01" && year.endsOn <= "2199-12-31",
  { message: "Enter a valid financial year date range." });

export const roleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.enum(permissions)).max(permissions.length),
}).transform((role) => ({ ...role, permissions: [...new Set(role.permissions)] }));

export function karachiToday() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts();
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function displayDate(date: string) {
  return date.split("-").reverse().join("-");
}
