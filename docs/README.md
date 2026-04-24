# server/docs

Engineering docs that live alongside the code.

## backlog.csv

Jira-importable backlog of outstanding TODOs across the liquidretail backend.

**Columns:** `Summary, Description, Issue Type, Priority, Component, Labels`

**Import path in Jira:**
1. Project → Board settings → Issues → Import from CSV
2. Upload `backlog.csv`
3. Map columns (they already match Jira's default field names)
4. Choose the target project key + issue type fallback
5. Dry-run, then import

**Editing convention:**
- When a ticket is created in Jira, remove the row from this CSV and reference the Jira key in the commit message (e.g. `LR-123: implement overlay placement v2`).
- When adding a new TODO mid-session, append a row here; it gets batched into the next Jira import.
- Commit message convention for edits to this file: `Backlog: add <short summary>` or `Backlog: close <row summary>`.

**Current counts** (at the time of the last refresh):
- 32 rows
- Components: Render, Overlay Zones, Layout Input, Extended Crops, Judge, Detect Pipeline, Product Matching, Brand Catalog, AI Layout Studio, Data Ingestion, Data Model, Workflow
- Priority distribution: 2 High, 12 Medium, 18 Low

## Adding new docs

Other engineering docs (architecture notes, runbooks, API specs outside schemas/) belong here. Keep anything user-facing in the frontend repo.
