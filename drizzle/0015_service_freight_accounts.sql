-- Permanent income and expense controls for Services and Freight / Transportation invoice lines.
-- A company that already uses one of these codes or names keeps its account; posting such a line then asks for the control.
INSERT INTO accounts (company_id, code, name, type, control)
SELECT c.id, a.code, a.name, a.type::account_type, a.control FROM companies c CROSS JOIN
  (VALUES ('4020','Service Income','income','service_income'),
          ('4030','Freight and Transportation Income','income','freight_income'),
          ('5180','Services Expense','expense','service_expense'),
          ('5190','Freight and Transportation Expense','expense','freight_expense')) AS a(code,name,type,control)
ON CONFLICT DO NOTHING;
