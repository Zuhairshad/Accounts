import { DatabaseSync } from "node:sqlite";

/**
 * Builds a SYNTHETIC SQLite file shaped like the mapping template, for automated tests only. It is not legacy data
 * and contains deliberate anomalies so every importer safeguard is exercised.
 */
export function buildLegacySqlite(path: string, variant: "clean" | "anomalies", token: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER);
    CREATE TABLE accounts(id INTEGER PRIMARY KEY, company_id INTEGER, code TEXT, name TEXT, type TEXT);
    CREATE TABLE parties(id INTEGER PRIMARY KEY, company_id INTEGER, party_type TEXT, name TEXT, phone TEXT, address TEXT);
    CREATE TABLE inventory(id INTEGER PRIMARY KEY, company_id INTEGER, item_name TEXT, unit TEXT, opening_qty REAL, opening_rate REAL);
    CREATE TABLE vouchers(id INTEGER PRIMARY KEY, company_id INTEGER, voucher_no TEXT, date TEXT, voucher_type TEXT, narration TEXT);
    CREATE TABLE voucher_lines(id INTEGER PRIMARY KEY, voucher_id INTEGER, account_id INTEGER, party_id INTEGER, debit REAL, credit REAL, description TEXT);
    CREATE TABLE invoices(id INTEGER PRIMARY KEY, company_id INTEGER, invoice_no TEXT, date TEXT, invoice_type TEXT, party_id INTEGER,
      item_id INTEGER, qty REAL, rate REAL, amount REAL, voucher_id INTEGER);
  `);
  const run = (sql: string, ...rows: unknown[][]) => { const s = db.prepare(sql); for (const r of rows) s.run(...(r as never[])); };
  run("INSERT INTO companies VALUES (?,?,?)", [1, variant === "clean" ? `Legacy Clean Co ${token}` : "AZAM TRADERS", 1]);
  run("INSERT INTO accounts VALUES (?,?,?,?,?)",
    [1, 1, "1000", "Cash", "Asset"], [2, 1, "1100", "Accounts Receivable", "Asset"], [3, 1, "1200", "Inventory", "Asset"],
    [4, 1, "2000", "Accounts Payable", "Liability"], [5, 1, "4000", "Sales Revenue", "Income"], [6, 1, "5000", "Cost of Goods Sold", "Expense"],
    [7, 1, "3000", "Owner Capital", "Equity"], [8, 1, "6500", "Legacy Freight", "Expense"]);
  run("INSERT INTO parties VALUES (?,?,?,?,?,?)", [1, 1, "Customer", "Ali Traders", "0300", "Lahore"], [2, 1, "Supplier", "Bilal Mills", "", ""]);
  if (variant === "anomalies") run("INSERT INTO parties VALUES (?,?,?,?,?,?)", [3, 1, "Customer", "Ali Traders", "", "Second shop"]);
  run("INSERT INTO inventory VALUES (?,?,?,?,?,?)", [1, 1, "Cloth roll", "roll", 0, 0], [2, 1, "Thread", "box", variant === "clean" ? 0 : 5, 20]);
  // Capital introduced; purchase 10 @ 100 on credit; sale 4 @ 150 (two rows of one invoice) with COGS; receipt.
  run("INSERT INTO vouchers VALUES (?,?,?,?,?,?)",
    [1, 1, "JV-1", "01-07-2025", "JV", "Capital introduced"], [2, 1, "PUR-1", "2025/07/02", "Purchase", "Purchase from Bilal"],
    [3, 1, "SAL-1", "2025-07-03", "Sale", "Sale to Ali"], [4, 1, "CRV-1", "04/07/2025", "CRV", "Receipt from Ali"]);
  run("INSERT INTO voucher_lines VALUES (?,?,?,?,?,?,?)",
    [1, 1, 1, null, 5000, 0, ""], [2, 1, 7, null, 0, 5000, ""],
    [3, 2, 3, null, 1000, 0, ""], [4, 2, 4, 2, 0, 1000, ""],
    [5, 3, 2, 1, 600, 0, ""], [6, 3, 5, null, 0, 600, ""], [7, 3, 6, null, 400, 0, ""], [8, 3, 3, null, 0, 400, ""],
    [9, 4, 1, null, 0.1 + 0.2, 0, "float noise"], [10, 4, 2, 1, 0, 0.30000000000000004, ""]);
  run("INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [1, 1, "P-1", "2025-07-02", "Purchase", 2, 1, 10, 100, 1000, 2],
    [2, 1, "S-1", "2025-07-03", "Sale", 1, 1, 3, 150, 450, 3], [3, 1, "S-1", "2025-07-03", "Sale", 1, 1, 1, 150, 150, 3]);
  if (variant === "anomalies") {
    run("INSERT INTO vouchers VALUES (?,?,?,?,?,?)",
      [5, 1, "JV-1", "2025-07-05", "JV", "Duplicate number"], [6, 1, "JV-6", "2025-07-06", "JV", "Unbalanced"],
      [7, 1, "JV-7", "31-02-2025", "JV", "Impossible date"], [8, 1, "JV-8", "2025-07-08", "JV", "Unlinked receivable"],
      [9, 1, "JV-9", "2025-07-09", "JV", "Party on freight"], [10, 1, "SAL-2", "2025-06-30", "Sale", "Backdated sale before purchase"]);
    run("INSERT INTO voucher_lines VALUES (?,?,?,?,?,?,?)",
      [11, 5, 1, null, 10, 0, ""], [12, 5, 7, null, 0, 10, ""],
      [13, 6, 1, null, 99, 0, ""], [14, 6, 7, null, 0, 98, ""],
      [15, 7, 1, null, 5, 0, ""], [16, 7, 7, null, 0, 5, ""],
      [17, 8, 2, null, 250, 0, ""], [18, 8, 5, null, 0, 250, ""],
      [19, 9, 8, 2, 30, 0, "freight"], [20, 9, 1, null, 0, 30, ""],
      [21, 10, 2, 1, 150, 0, ""], [22, 10, 5, null, 0, 150, ""],
      [23, 999, 1, null, 1, 0, "orphan"]);
    run("INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?,?,?,?)", [4, 1, "S-0", "2025-06-30", "Sale", 1, 1, 1, 150, 150, 10],
      [5, 1, "S-9", "2025-07-09", "Sale", 1, 1, 1, 150, 150, 9], [6, 1, "S-9", "2025-07-10", "Sale", 1, 1, 1, 150, 150, 9]);
  }
  // A per-run marker table keeps each synthetic file unique for repeat-import protection.
  db.exec(`CREATE TABLE test_marker(token TEXT); INSERT INTO test_marker VALUES ('${token}')`);
  db.close();
}
