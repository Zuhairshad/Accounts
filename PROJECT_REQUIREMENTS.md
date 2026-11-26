# Project requirements

AZAM EASY ACCOUNTS V4.0 is a browser-based multi-company accounting application. All phases extend this repository and the same PostgreSQL schema through versioned migrations. The Phase 1 foundation and Phase 2 core accounting briefs define this release. Subsequent prompts govern the remaining phases.

- **Web runtime** uses Next.js App Router, React, TypeScript, Tailwind CSS, a shadcn-style button and Lucide React. The target is Vercel from GitHub.
- **Persistent data** uses Neon PostgreSQL and Drizzle. Runtime and migration connections belong to separate roles. Use isolated development, test and production databases.
- **Identity** uses Auth.js password credentials with centralized session checks, company roles, an interactive password change and a terminal-only initial administrator setup.
- **Company configuration** includes the three exact starter names, authorized switching, lifecycle status, membership, roles, dated financial years and company/document details.
- **Workspace** includes company search, selected dates, notifications from actual user actions, the profile menu and database-backed posted activity. The module directory names the planned workflows.
- **Legacy continuity** follows the source inventory in [LEGACY_FEATURE_MAP.md](LEGACY_FEATURE_MAP.md). The original SQLite schema is a migration reference. No live data was supplied.
- **Recovery** combines Neon point-in-time recovery with scheduled, encrypted independent dumps. Production activation and a restore drill require configured infrastructure.

The Phase 1 overview is scoped to posted vouchers and their journal lines. It does not replace statutory reporting or the legacy account-head consolidation, which need their own accounting acceptance tests.

Phase 2 covers the chart, all six manual voucher types, authorized draft approval, effective journal revisions and restoration, account and party openings, party aging, settlement allocation and voucher PDF output. Future trade and inventory workflows will post through this engine.

Phase 3 adds four invoice types, their linked journals and PDF documents, inventory products and services, audited inventory adjustments, chronological valuation and stock-safe source revisions. Formal report expansion and legacy data migration remain for later phases.

## Phase 4 reporting workflow

Provide a browser-based report center with journal, financial, operational and cross-company reports. Support accounting-date filters, posted drill-downs, authorized audit history, actual PDF and browser printing, and Excel and CSV exports. Provide the illustrated Sale / Purchase and Day Book as editable registers with blank print templates, autosave, conflict detection and explicit accounting linkage.
