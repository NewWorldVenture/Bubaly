# Audit Ledger (pointer)

The repo's audits live where they were executed, with evidence:

- **UI/UX, all 136 dashboard pages, graded** → `todo.md` § "SITE-WIDE UI/UX AUDIT" (+ second
  pass § "Audit second pass"). Method: signal scan + manual bottom-cohort review; 3 rebuilds.
- **Competitor matrices (10 opportunities + 28 features)** → `todo.md` § "Largest opportunities"
  + § "Missing Competitor Features" — every row verdicted against actual routes/libs; gaps built.
- **Security passes** → `security-review.md` (consolidated) + `todo.md` § "Full stone-turn pass".
- **API auth audit (95 routes), dead links (172 hrefs), family-scoping audit** → same stone-turn
  section, with the fixes.
- **Route inventory** → `route-inventory.md` (348 pages). **Database** → `database-map.md`
  (418 tables). **Features** → `feature-inventory.md`.
- **Prod-apply state** → `docs/PENDING_PROD_MIGRATIONS.md`. **Session handoffs** →
  `docs/AGENT_HANDOFF.md`.

Nothing in these audits is marked verified without a command run or a file-level check;
re-run instructions are embedded in each section.
