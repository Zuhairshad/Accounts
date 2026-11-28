# Decisions

- Use stable Auth.js v4 Credentials and encrypted JWT cookies. Every protected request rechecks the PostgreSQL account and session version. The original login is not carried over.
- Initial administrators are bootstrapped with a separately privileged operator connection and password through stdin. The application role may provision regular accounts from the authorized UI. Initial passwords must be changed at first sign-in.
- Store company IDs in URL routes. Company labels can change without changing IDs. Deactivation hides companies from accounting and switching while allowing authorized administrators to restore access.
- Seed the company's original nineteen chart accounts and five company-local roles when a company is created. Super Admin is a separate global privilege. Financial years remain unseeded until actual company dates are configured.
- Store the logo as a validated HTTPS URL. Source media is separate from the company database. Later print/export code must enforce a trusted asset boundary before fetching remotely.
- Differentiate the phase-one combined activity table from historical company-wise/consolidated reports and combined party balances. Develop both legacy reporting views in subsequent phases.
- Use PostgreSQL's database constraints as well as server authorization. Financial mutation privileges and trade posting services will be added with the appropriate later phase.
- The reference archive contains no live database. All existing transactions and user mappings require a separate authorized migration, reconciliation and sign-off when a legacy database is supplied.

## Phase 2

- Preserve the append-only Phase 1 journal and project official activity through `effective_vouchers`. The visible number belongs to the logical voucher, whose active physical journal can change. Existing unmanaged posted vouchers remain in the projection and can be adopted for permitted manual edits or explicit party repairs.
- Use a closed-period guard on both the original posting and a proposed replacement. An approved reopening is recorded with a reason. Current-period corrections use an independent journal and leave the original period closed.
- Keep the legacy nineteen chart accounts and add the permanent controls for sales returns, inventory adjustment, retained earnings and opening equity. Keep the initial opening offset configurable.
- Use event-dated settlement records. Existing allocations must be released before changing their payment journal. Void and restore affect the journal exactly once. The separately released allocations can be reallocated by an authorized user.
- New draft approvals use two people when enabled. Only users who have the approval permission can make posted revisions and lifecycle changes governed by that policy.
- Leave invoice, return and inventory authoring to their designated phase. Phase 2 provides their shared posting entry point and verifies it against actual posted source rows in PostgreSQL tests.

## Phase 3

- Replay stock and trade at the company lock boundary. Each source retains its normalized terms and a fingerprint of the derived journal and stock. Revisions are written only for changed effects. This favors a deterministic audit trail. Production-scale replay latency was not benchmarked during this phase.
- Preserve current source and historical versions in PostgreSQL. For imported movements without editable source terms, accept the recorded carrying values only when chronological replay reconciles. Fail changes that would alter unverified imported history.
- Preserve the inventory journal for both amount and quantity. Zero-value stock, a genuinely zero-value invoice and an unchanged authorized count can retain a valid source and journal number with zero monetary lines.
- Support separately configured numeric tax and withholding entry. The system applies entered amounts to the declared ledger controls. It does not determine statutory rates or eligibility.

## Phase 4 reporting decisions

- Audit views require approval permission. Transaction history refers to the state recorded as of the specified system time. Current account and party descriptions can reflect later master-data renames.
- A4 portrait, column proportions, row counts and margins were estimated from the photographs. Authorized company administrators can change widths, rows per page, row height and margins.
- Each report reads a repeatable PostgreSQL snapshot per request. Print, PDF, Excel and CSV use the same report query, cell values and sort order. A later request can include entries posted after a screen opened.

## Invoice line types and sales executives

- Classify Product, Services and Freight / Transportation per invoice line rather than per invoice, so one invoice can carry products and a freight charge. Existing lines are Product. Product calculations omit the new field so each existing invoice keeps its effect fingerprint and is not revalued by the next replay.
- Keep the item kind. Services and freight lines use a service item because an invoice line always names an item and the stock replay depends on that. Their default ledger is a permanent system control for the line type, not the item's service purchase account.
- Store the receipt's sales executive on its voucher document instead of adding a separate source type, so the receipt remains an ordinary editable CRV or BRV. Executives are deactivated, never deleted.
- Report collapsible groups only change the screen. Print, PDF, Excel and CSV always contain every row.
