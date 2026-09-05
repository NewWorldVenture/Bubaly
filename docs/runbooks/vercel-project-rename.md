# Vercel project rename runbook — `familyos` → `bubaly`

**Performed 2026-09-05.** The Vercel project at `vercel.com/newworldventure/familyos` was
renamed to `vercel.com/newworldventure/bubaly`. Project ID is unchanged
(`prj_z6gfMs2a8xGJ4ExbBDshtraYLQyi`) — a rename never creates a new project.

Use this document for any future rename, and to understand why some `familyos`
strings in this repo are deliberately left alone.

## What a rename does NOT affect

Everything below binds to the **project ID**, not the project name, so none of it
moved and none of it needed reconfiguring:

- **Custom domains** — `www.bubaly.com` (canonical) and `bubaly.com` (308 → www).
  Production traffic never touches the project name.
- **Environment variables** — including `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`,
  `CRON_SECRET`, and every provider secret.
- **Cron jobs** — `vercel.json` schedules are attached to the project.
- **Git integration** — the connected repo/branch and deploy hooks.
- **Existing deployment URLs** — each immutable `*-<hash>-<scope>.vercel.app` deployment
  URL keeps resolving.

## What a rename DOES change

1. **The generated project alias is released.** `familyos.vercel.app` stops pointing at
   this project and becomes claimable by anyone. `bubaly.vercel.app` becomes the new
   generated alias.
2. **Preview URLs change prefix** — `familyos-*.vercel.app` → `bubaly-*.vercel.app`.
   Anything that allow-lists preview hosts by name must be updated (see below).
3. **OIDC token claims change** — the `sub` claim embeds the project name. Vercel warns
   about this on the rename dialog. **Not applicable here:** this project does not use
   Vercel OIDC federation (no `VERCEL_OIDC_TOKEN` reference anywhere in the codebase),
   so the warning is safe to dismiss.

## Rule: never point an integration at a `*.vercel.app` alias

The generated alias is a function of the project name, so any integration configured
against it breaks on the next rename — silently, and only for the flow that uses it.
Every external callback must use the canonical custom domain `https://www.bubaly.com`.

Check these after any rename. Each one is configured **outside this repo**:

| Where | Setting | Must be |
| --- | --- | --- |
| Vercel → Settings → Environment Variables | `NEXT_PUBLIC_APP_URL` | `https://www.bubaly.com` |
| Vercel → Settings → Environment Variables | `NEXT_PUBLIC_SITE_URL` | `https://www.bubaly.com` |
| Supabase → Authentication → URL Configuration | Site URL | `https://www.bubaly.com` |
| Supabase → Authentication → URL Configuration | Redirect allow-list | `https://www.bubaly.com/auth/callback` — plus `https://bubaly-*.vercel.app/**` if preview logins are wanted |
| Google Cloud console → Credentials | Authorised redirect URIs | `https://<project-ref>.supabase.co/auth/v1/callback` and `https://www.bubaly.com/api/google/calendar/callback` |
| Google Cloud console → Credentials (sync client) | `GOOGLE_SYNC_REDIRECT_URI` | `https://www.bubaly.com/api/sync/google/callback` |
| Entra → App registrations | `MICROSOFT_SYNC_REDIRECT_URI` | `https://www.bubaly.com/api/sync/microsoft/callback` |
| Stripe → Webhooks | Billing endpoint | `https://www.bubaly.com/api/webhooks/stripe` |
| Stripe → Webhooks | Money/Issuing endpoint | `https://www.bubaly.com/api/webhooks/money` |
| Resend → Webhooks | Endpoint | `https://www.bubaly.com/api/webhooks/resend` |
| Twilio → phone number config | Voice/SMS callbacks | `https://www.bubaly.com/api/guardian/...` |

`NEXT_PUBLIC_APP_URL` is the base for OAuth callbacks, Twilio webhooks, and Stripe
return URLs (`lib/google.ts`, `lib/contact-center/server.ts`, `app/api/billing/*`), so
it is the single highest-impact value in that table.

## Verification

Run after the rename and after the next production deploy:

```bash
# Canonical domain must serve production; apex must redirect to www.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.bubaly.com   # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://bubaly.com       # 308 -> www

# App self-report: required env present, PostgREST + GoTrue reachable.
curl -s https://www.bubaly.com/api/health    # {"status":"ok","checks":{"env":{"missing":[]},...}}

# Crawler + PWA files must be 200, never 307 to /login.
for p in /robots.txt /sitemap.xml /manifest.webmanifest /sw.js; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "https://www.bubaly.com$p"
done
```

The alias flip is not instant: `familyos.vercel.app` may keep serving until the next
production deployment promotes, and `bubaly.vercel.app` 404s until then. Re-check both
after the next deploy to confirm the swap completed.

## `familyos` strings that intentionally stay

Do **not** "finish the rename" by changing these — each one is load-bearing:

- **Deterministic seed keys** in `supabase/SEED_ALL.sql`,
  `supabase/seed_marketplace_handoffs.sql`, `supabase/seed_marketplace_returns.sql`,
  `supabase/seed_recent_updates.sql` — e.g. `md5('familyos-seed-handoff-listing-' || i)::uuid`.
  These hash to primary keys that already exist in production. Changing the string
  produces different UUIDs, so the `on conflict do nothing` guards stop matching and the
  seeds insert duplicate rows. `tests/seed-data-safety-contract.test.ts` pins the exact
  strings as a guard.
- **`'cluster','family-os'`** — an internal SEO keyword-cluster tag written by
  `supabase/migrations/0229_seed_marketing_aeo_seo.sql` (1603 rows, already applied) and
  regenerated by `scripts/generate-marketing-seed.mjs`. It is never rendered to users;
  changing it would drift the generator from applied production data.
- **`@familyos.com` admin emails** in `supabase/CATCH_UP_PROD.sql` — seeded account
  identities. Rewriting them inserts new admin rows rather than renaming existing ones.

No user-visible copy anywhere in the app says "FamilyOS" — the product has been branded
Bubaly in `app/`, `components/`, and metadata throughout.

## Open item: account plan

The Vercel scope badge reads **Hobby**, but `docs/AGENT_HANDOFF.md` records the account
as upgraded to **Pro**. These disagree, and the difference is material:

- Hobby caps cron jobs at **2 per account, once-daily**. `vercel.json` declares **21**
  crons on varied schedules — well past that ceiling.
- Hobby licence terms exclude commercial use; this app bills through Stripe.

Confirm the live plan in Vercel → Settings, and reconcile the handoff doc with it.
