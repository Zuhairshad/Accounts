import { Client } from "pg";
import { z } from "zod";

const role = z.string().regex(/^[a-z][a-z0-9_]{1,50}$/).parse(process.argv[2]);
const connectionString = process.env.DATABASE_MIGRATION_URL;
if (!connectionString) throw new Error("DATABASE_MIGRATION_URL is required");

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  const lookup = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    "SELECT rolsuper, rolbypassrls, rolname FROM pg_roles WHERE rolname = $1", [role],
  );
  const ownership = await client.query<{ current_user: string; owner: string }>(
    "SELECT current_user, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()",
  );
  if (!lookup.rows[0] || lookup.rows[0].rolsuper || lookup.rows[0].rolbypassrls ||
      [ownership.rows[0].current_user, ownership.rows[0].owner].includes(role)) {
    throw new Error("Specify a separate, unprivileged PostgreSQL role.");
  }
  const quoted = `"${role}"`;
  await client.query(`
    GRANT USAGE ON SCHEMA public TO ${quoted};
    GRANT SELECT ON users, companies, company_settings, company_members, company_roles, financial_years,
      accounts, parties, vouchers, journal_lines, invoices, audit_logs, login_attempts TO ${quoted};
    REVOKE INSERT ON users FROM ${quoted};
    GRANT INSERT (username, display_name, password_hash) ON users TO ${quoted};
    GRANT INSERT ON companies, company_settings, company_members, company_roles,
      financial_years, accounts, audit_logs, login_attempts TO ${quoted};
    GRANT UPDATE ON companies, company_settings, company_members, company_roles, login_attempts TO ${quoted};
    GRANT UPDATE (password_hash, must_change_password, session_version) ON users TO ${quoted};
    GRANT SELECT ON accounting_periods, effective_vouchers, voucher_documents, voucher_versions, document_sequences,
      idempotency_requests, transaction_revisions, deleted_records, restoration_history, payment_allocations,
      opening_balances, inventory_adjustments, inventory_items, inventory_units, invoice_lines,
      stock_movements, inventory_valuations, sale_purchase_register_entries, day_book_entries TO ${quoted};
    GRANT INSERT ON accounting_periods, vouchers, journal_lines, voucher_documents, voucher_versions, document_sequences,
      idempotency_requests, transaction_revisions, deleted_records, restoration_history, payment_allocations,
      parties, opening_balances, inventory_adjustments, inventory_items, inventory_units, invoices,
      invoice_lines, stock_movements, inventory_valuations, sale_purchase_register_entries, day_book_entries TO ${quoted};
    GRANT UPDATE ON accounting_periods, financial_years, vouchers, voucher_documents, document_sequences,
      idempotency_requests, accounts, parties, payment_allocations TO ${quoted};
    GRANT UPDATE ON inventory_adjustments, inventory_items, invoices TO ${quoted};
    GRANT SELECT ON report_settings, report_account_mappings, manual_register_rows, voucher_timeline TO ${quoted};
    GRANT INSERT, UPDATE ON report_settings, report_account_mappings, manual_register_rows, voucher_timeline TO ${quoted};
    GRANT DELETE ON company_members TO ${quoted};
  `);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
console.log("Accounting runtime grants applied.");
