import Decimal from "decimal.js";

export function formatMoney(value: string) {
  const exact = new Decimal(value).toFixed(2);
  const [whole, fraction] = exact.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
