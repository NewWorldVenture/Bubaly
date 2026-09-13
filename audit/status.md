# Status board

Each worker maintains ONLY its own section. Read the others before you start
anything, and before you touch a file.

---

## Claude-1
CURRENT: merged Claude-4's P-01 into finalaudit.md (verified independently, fixed, two guards added); architecture sweeps 1-3 done
COMPLETED: Passes A-O (15 passes, 63 findings, 20 probes, 9 CI-enforced guards) · finalaudit.md restructured to the 19-section layout with every original sub-heading preserved byte-identical · workspace created · Claude-2/3/4 dispatched · architecture sweep 1 (anti-drift helper adoption) = 3 findings + 1 verified-clean
NEXT: merge Claude-2 and Claude-3 when they land; then rebuild finalaudit.md from all four files
FILES-TOUCHED: finalaudit.md, audit/README.md, audit/claude-1.md, audit/status.md, docs/PENDING_PROD_MIGRATIONS.md, lib/constants/feature-catalog.ts, tests/route-plan-gate.test.ts, tests/every-gate-key-is-in-the-catalog.test.ts
BLOCKERS: none. Note: another SESSION also pushes to claude/roadmap-implementation-ld8bon - always fetch+merge (never rebase) before pushing.
LAST-UPDATE: 2026-09-13T23:18Z

---

## Claude-2
CURRENT: done — 17 findings written to audit/claude-2.md (1 CRITICAL, 4 HIGH, 7 MEDIUM, 3 LOW, 9 INFO/clean)
COMPLETED: (1) missing error/empty/loading states across 395 pages; (2) a11y — icon names, keyboard operability, focus visibility, labels, alt, skip link, aria-live, modal contract, contrast; (3) responsive — tables, fixed widths, iOS 16px rule; (4) i18n in the UI — lib/guardian catalogs + 245 hardcoded 'en-US' formatters; (5) client/server — bundle weight, useEffect fetches, TZ/hydration; (6) forms — double-submit, labels, destructive confirms
HEADLINE: CRITICAL components/modules/calendar-module.tsx buckets events by UTC date against local-midnight columns — PROVEN by TZ replay: every event lands one column off in Europe/Amsterdam + Asia/Tokyo (Sunday vanishes entirely), and every evening event does the same in America/*. HIGH app/globals.css:179 .focus-ring is unscoped — PROVEN by compiling with the repo's own tailwind config: `outline: 2px solid transparent` with no :focus selector, so 202 elements have no visible focus indicator (the 16 that use focus-visible:focus-ring are all on the marketing surface).
NEXT: available for follow-up verification; happy to re-prove any finding on request
FILES-TOUCHED: audit/claude-2.md, audit/status.md (own section only). NO SOURCE FILE MODIFIED — audit only, all fixes are written as recommendations for Claude-1.
FILES-READ-CLOSELY (for Claude-1 before editing): components/modules/calendar-module.tsx, app/globals.css, components/ui/input.tsx, components/ui/states.tsx, app/(app)/guardian/*, app/(app)/family/*, app/(app)/dashboard/family-access/page.tsx, components/guardian/routing-settings.tsx, components/guardian/call-history.tsx, design/tokens.json, lib/utils/format.ts, lib/guardian/*
BLOCKERS: none
LAST-UPDATE: 2026-09-13T23:45Z

---

## Claude-3
CURRENT: DONE - 12 findings written to audit/claude-3.md (9 defects + 3 INFO/verified). Ground-truth PG16 on port 5434 still up if anyone wants it.
COMPLETED: auth flows end-to-end, RLS write boundaries (acting AS authenticated), webhooks, rate-limit coverage, FK/index shape, secdef search_path, anon RPC grants, secrets fail-open, SSRF, body bounds, .or()/order injection. 310 migrations replayed, 491 tables, probes 20/20 green.
HEADLINE: **CRITICAL** `invites_update` has no WITH CHECK -> a guest invitee rewrites family_id+role and accept_invite makes them `parent` of ANY household (proven twice, incl. a family she was never invited to). Pass I read this policy and called it "exactly right" - it read USING and not the missing WITH CHECK.
ALSO HIGH: child-PIN throttle bypass via ILIKE `_` wildcard (16 buckets per 6-char username); `child_logins` "Managers manage" policy admits any member (child deleted a sibling's login); 163 CASCADE FKs with no index (measured 5,715 buffers -> 4); `audit_logs` lets any member forge actor_id, incl. the family_id-NULL rows the admin Security page renders with the service client (0260 fixed exactly this on trust_audit_logs and left audit_logs open).
NEXT: nothing queued - available if Claude-1 wants any finding re-proved or a probe drafted.
FILES-TOUCHED: audit/claude-3.md, audit/status.md (own section only) - AUDIT ONLY, zero source edits
BLOCKERS: none. Fixes are Claude-1's to apply; every finding carries the exact SQL/TS change.
LAST-UPDATE: 2026-09-14T00:20Z

---

## Claude-4
CURRENT: sweep 3 — end-to-end flows (invite/onboarding, concierge, calendar sync) + edge cases on a live 310-migration replay
COMPLETED: sweep 1 (feature gates that cannot fail — 2 findings); sweep 2 (money spine, raced on real PG — 3 findings)
NEXT: (1) signup→family→invite→accept, (2) concierge run→approval→execution, (3) timezone/DST/month-end edges, (4) N+1 + unbounded reads, (5) vacuous-test census
FILES-TOUCHED: audit/claude-4.md, audit/status.md (own section only) — AUDIT ONLY, no source edits. Throwaway PG running at /tmp/pgaudit_db:54399 (docs/audit/verify-pg.sh) — will tear down at the end.
BLOCKERS: none
LAST-UPDATE: 2026-09-14T00:05Z
