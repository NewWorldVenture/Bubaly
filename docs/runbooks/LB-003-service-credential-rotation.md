# LB-003 runbook — rotate the exposed Supabase service credential

**P0 launch blocker. Owner / secret-manager task** (agents have no prod secrets). A historical
Supabase **service-role** credential was exposed and must be rotated, deployment secrets updated, and
the old key proven dead.

## What's exposed and where it's used (from the code)

- The secret is `SUPABASE_SERVICE_ROLE_KEY` (the Supabase **service_role** JWT — full DB access, bypasses
  RLS). Grounding: it is read in **7 server-only** places —
  `lib/supabase/server.ts` (`createServiceClient()` — the choke point), `lib/health/status.ts`,
  `lib/marketing/unsubscribe.ts`, `app/(app)/admin/users/page.tsx` (server component), and the
  `scripts/{audit-supabase-auth,seed-client,run-e2e}.mjs` tooling.
- **Good news, confirmed:** it is **never** `NEXT_PUBLIC_`-prefixed and never imported into a client
  bundle — so the leak is *historical* (git history / logs / a shared paste), not an ongoing
  client-side exposure. Rotation + scrubbing closes it.

## Rotate (pick the path that matches your Supabase project)

Supabase has two key regimes; check Dashboard → **Settings → API**.

**Path A — legacy JWT-based keys (anon + service_role are JWTs signed by the project JWT secret).**
Rotating the service_role key means **rotating the JWT secret**, which regenerates BOTH the `anon` and
`service_role` keys and **invalidates every existing key + all user sessions**. So:
1. Dashboard → Settings → API → **Generate new JWT secret** (or use the API-keys rotate control).
2. Copy the **new** `anon` and `service_role` keys.
3. Update **every** deployment target's env (see checklist below) with the new keys **in the same
   change window** — because the old anon key also dies, a half-updated deploy will 401 users.
4. Redeploy so all instances pick up the new keys.
> ⚠️ This logs out all signed-in users (sessions are signed by the old secret). Do it during a
> maintenance window and communicate it.

**Path B — new publishable/secret API keys (if your project shows `sb_secret_…`).**
You can rotate the **secret key alone** without touching the anon/publishable key or user sessions:
1. Dashboard → Settings → API keys → **Roll** the secret key (create new, then revoke old).
2. Update `SUPABASE_SERVICE_ROLE_KEY` (the secret) everywhere; anon key unchanged; no forced logout.

## Update deployment secrets (checklist — all of these hold the key)

- **Vercel** (or host): Project → Settings → Environment Variables → `SUPABASE_SERVICE_ROLE_KEY`
  (and `NEXT_PUBLIC_SUPABASE_ANON_KEY` too if Path A) for **Production AND Preview**. Redeploy.
- **GitHub Actions**: repo/org **Secrets** used by `ci.yml` if any reference the real project (the e2e
  job uses ephemeral `supabase start` keys, so it likely needs no change — verify).
- **Any local `.env`/`.env.local`** on developer or ops machines.
- **Any other integration** that was handed the service key (background workers, cron infra, Zapier,
  etc.).

## Prove the old key is dead

With the **old** service key, both must now fail (401/403):
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "apikey: $OLD_SERVICE_KEY" -H "Authorization: Bearer $OLD_SERVICE_KEY" \
  "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/admin/users?page=1&per_page=1"      # expect 401
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "apikey: $OLD_SERVICE_KEY" -H "Authorization: Bearer $OLD_SERVICE_KEY" \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/families?select=id&limit=1"          # expect 401
```
And the **new** key works: `npm run db:audit:auth` (with the new env) → both probes OK, and
`GET /api/health` → 200 (env + PostgREST + GoTrue all green — see `docs/PENDING_PROD_MIGRATIONS.md` /
the `/api/health` endpoint).

## Scrub the historical exposure (don't skip)

Rotation kills the old key, but also remove the exposed value so it can't confuse future audits:
- Purge it from git history if it was committed (BFG / `git filter-repo`) and force-push (coordinate
  with the fleet — this rewrites history).
- Delete it from any logs, screenshots, chat, or the readiness report where it was pasted.
- Confirm no `.env*` with a real key is tracked: `git ls-files | grep -E '\\.env'` should show only
  `.env.example`-style templates.

## Exit criteria

Old key returns 401 on both probes above; new key passes `db:audit:auth` + `/api/health`; all deploy
targets updated + redeployed; exposed value scrubbed from history/logs. Then flip LB-003 → Resolved.
Coordinate with **LB-001** (if you rotate via Path A, re-run `db:audit:auth` afterward — a stale env
var is a common cause of a post-rotation admin-users failure).
