# LB-008 runbook — backup/restore + deploy-rollback rehearsal

**P1. Owner (Supabase + host access).** Prove you can recover the database and roll back a deploy
*before* launch, and capture the artifact. This is a rehearsal into an **isolated** target — never
restore over prod.

## A. Database restore drill (Supabase)

1. **Confirm backups exist / PITR is on.** Supabase Dashboard → Database → **Backups**. Note the
   retention window and that Point-in-Time Recovery is enabled (required for a real RPO).
2. **Restore into an isolated target.** Either restore a backup into a **new** Supabase project, or use
   PITR to a fresh project/branch. Pick a timestamp and record it.
3. **Validate the restored DB with the repo's own auditors** (point the env at the restored project):
   ```bash
   npm run db:audit:migrations   # migration ledger intact (expect: passed, next 0225)
   npm run db:audit:schema       # schema probes pass
   npm run db:audit:auth         # auth health + admin users OK (see LB-001 if 500)
   ```
   Then hit `GET /api/health` against an app instance pointed at the restore → **200** (env + PostgREST
   + GoTrue green). Spot-check row counts for a known family (families, family_members, wallet_*,
   documents) match expectations for the restore timestamp.
4. **Record**: backup used, restore duration (your RTO), the timestamp gap (your RPO), and the audit
   output. That's the LB-008 evidence.

> Storage note: Supabase Storage objects (buckets `documents`, `chore-proof`, `family-media`, …) are
> backed up separately from Postgres on most plans — confirm your plan covers bucket restore, or
> document the storage backup mechanism. A DB restore alone won't bring back uploaded files.

## B. Deploy rollback drill (host, e.g. Vercel)

1. Note the current production deployment id.
2. Ship a trivial change (or pick a prior good deployment) and then **roll back**: Vercel → Deployments
   → **Promote** the previous deployment (or `vercel rollback`).
3. Verify the app serves the previous version (check a visible marker or the build id) and `GET
   /api/health` stays 200 throughout. Record the rollback time.

## C. Runbook-ready failure modes to note

- If a restore reveals the auth schema is behind (admin-users 500), that's **LB-001** — same fix.
- If restored features render empty, the **pending migrations** likely weren't applied to that project —
  run `supabase db push` (see `docs/PENDING_PROD_MIGRATIONS.md`) before validating.
- Keep the restore target isolated; tear it down after capturing evidence (avoid a second live DB with a
  real service key floating around — relates to LB-003).

## Exit criteria

A completed restore into an isolated project with the three `db:audit:*` scripts + `/api/health` green,
a measured RTO/RPO, and a demonstrated deploy rollback — artifacts attached. Then flip LB-008 → Resolved.
