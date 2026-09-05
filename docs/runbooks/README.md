# Launch-to-GO — owner playbook

**Current decision: NO-GO.** Every open blocker is **owner-gated** (needs prod DB credentials, live
keys, infra/billing access, or a product decision) — no agent can execute them. The audit + code work
is done and locally verified green; this is the ordered sequence to flip the decision to GO. Each step
links to a grounded runbook with exact commands + exit criteria.

Source of truth for status: `docs/LAUNCH_BLOCKERS.md` (LB-xxx) and `docs/PRODUCT_LAUNCH_AUDIT.md`
(PLA-xxxx). Do the steps roughly in this order — earlier ones unblock later evidence.

## 0. Restore CI first (unblocks all automated evidence) — LB-015

CI has been failing at **infrastructure/provisioning** (every run ~5s, no runner) — **not a code
failure** (all 7 quality gates pass locally: `npm ci`, `npm audit --omit=dev`, `db:audit:migrations`,
`tsc`, lint, `vitest` 3559, `build`). Fix: GitHub Actions **runner availability / minutes / spending
limit** for `NewWorldVenture/Bubaly`. Once green, the authed-E2E + build + test evidence generates
itself on every push. (LB-015 in `docs/LAUNCH_BLOCKERS.md`.)

## 1. Apply the pending prod migrations — **P0 security first**

The **single highest-priority action.** Open `docs/PENDING_PROD_MIGRATIONS.md` → the **🔴 SECURITY
MIGRATIONS — APPLY FIRST** table. Fastest safe path: `supabase db push` (all additive + idempotent).
Order that matters: **`0217` (P0 wallet money-mint)** first, then `0224`/`0219`/`0221`/`0222`/`0223`/
`0216`/`0218`, then the `0118–0135` feature bundle. Each row has a post-apply verification query. Also
set **`CRON_SECRET`** (all 19 cron jobs 401 without it). Closes LB-010/LB-011/LB-012 + LB-002.

## 2. Rotate the exposed service credential — LB-003 (P0)

`docs/runbooks/LB-003-service-credential-rotation.md` — rotate the Supabase `service_role` key, update
every deploy target's env, prove the **old** key returns 401, scrub it from history/logs. (It was never
client-exposed — the leak is historical.)

## 3. Fix the Auth Admin 500 — LB-001 (P0)

`docs/runbooks/LB-001-auth-admin-500.md` — `GET /auth/v1/admin/users` returns 500 "Database error
finding users." It's a **DB-query failure with a valid key** (don't rotate keys for this). Ordered
diagnosis: Postgres logs → auth-schema drift → corrupt rows → role grants. Verify with
`npm run db:audit:auth`.

## 4. Authenticated live E2E — LB-005 (P1)

`docs/runbooks/LB-005-authenticated-e2e.md` — **already built + CI-wired and self-provisioning** (no
external test credentials). Either restore CI (step 0) and it runs on every push, or run it locally:
`supabase start` → set `E2E_AUTHENTICATED=1` + throwaway email/password → `npm run test:e2e`.

## 5. Backup/restore + rollback drill — LB-008 (P1)

`docs/runbooks/LB-008-backup-restore-drill.md` — restore a Supabase backup/PITR into an **isolated**
project, validate it with `db:audit:{migrations,schema,auth}` + `/api/health`, measure RTO/RPO, and
demonstrate a deploy rollback. (Note: Storage buckets back up separately from Postgres — confirm both.)

## 6. Third-party callback smoke — LB-006 (P1)

`docs/runbooks/LB-006-provider-callback-smoke.md` — smoke every signature-verified webhook with the
provider sandboxes: `/api/webhooks/stripe` + `/api/webhooks/money` (Stripe CLI `trigger`/`resend`),
`/api/webhooks/resend` (Svix test), the Twilio-signed `/api/guardian/inbound/*`, plus Google OAuth
round-trip and web push. Per callback: valid→200, replay→idempotent, forged signature→4xx.

## 7. Product decisions (no code blocked on them until decided)

- **LB-009** — `family-media` public→signed URLs. Plan ready:
  `docs/runbooks/LB-009-family-media-signed-urls.md` (photos already store `storage_path`; only messages
  need a backfill; sequence prevents breakage).
- **PLA-0610** — family-PII visibility model (should children read a parent's passwords/medical/IDs?).
- **PLA-0581** — "Secure Vault" is label-only today; decide whether it needs real gating beyond family RLS.

## Release rule

No GO while any **P0** is open (LB-001, LB-003, LB-010 via migration 0217) or a P1 lacks owner + exit
criteria + evidence. Steps 1–3 clear the P0s; 0/4/5/6 clear the P1 evidence; 7 are product calls.
