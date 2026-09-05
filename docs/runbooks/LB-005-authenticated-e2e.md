# LB-005 runbook — run the authenticated E2E journey (it's already built + CI-wired)

**A-20 / A-03 finding.** LB-005 is recorded as "authenticated browser E2E includes an intentional
skip." Grounding it in the code shows it's **more done than the blocker implies**: the authenticated
journey exists (`tests/e2e/authenticated.spec.ts`) and the CI e2e job **already runs it against an
ephemeral local Supabase** — it does **not** need external prod test credentials. Its only real
blocker is that CI can't currently execute (LB-015 infra).

## How it's wired (from the repo)

- `tests/e2e/authenticated.spec.ts` — `test.describe('authenticated first-value journey')`; each test
  is `test.skip(!enabled, …)` where `enabled = process.env.E2E_AUTHENTICATED === '1'`. It signs in,
  completes onboarding, and persists a first task. It also **refuses to run against a non-local
  Supabase** unless `E2E_ALLOW_REMOTE_SUPABASE=1` (a safety guard against seeding prod).
- Env it needs: `E2E_AUTHENTICATED=1`, `E2E_AUTH_EMAIL`, `E2E_AUTH_PASSWORD`, plus
  `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`.
- `playwright.config.ts` — starts the app itself (`next start` on `PLAYWRIGHT_PORT`, default 3107) and
  injects the Supabase env; set `PLAYWRIGHT_EXTERNAL_SERVER=1` to point at an already-running server.
- `.github/workflows/ci.yml` (E2E job) — already does the full sequence: `supabase start` →
  overrides env to the **local** Supabase (`api.url`, `auth.anon_key`, `auth.service_role_key`) →
  `db:audit:auth` + `db:audit:schema` → `test:e2e` with `E2E_AUTHENTICATED=1` and a unique per-run
  `E2E_AUTH_EMAIL=bubaly-e2e-<run_id>-<attempt>@example.test`.

**So the CI authed E2E self-provisions a throwaway Supabase — there is no "missing test credentials"
gap.** The reason it isn't producing green evidence is **LB-015**: the CI jobs currently fail at
runner provisioning (~5s, no runner), so the e2e job never starts. Fix LB-015 and this runs on every
push.

## Run it locally (to get the evidence now, without waiting on CI)

Requires Docker (for `supabase start`). From the repo root:
```bash
# 1) throwaway local Supabase
supabase start
# capture the printed API URL + anon + service_role keys, then:
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
export NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase start>
export SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase start>

# 2) enable the authed journey + a unique throwaway account
export E2E_AUTHENTICATED=1
export E2E_AUTH_EMAIL="bubaly-e2e-$(date +%s)@example.test"
export E2E_AUTH_PASSWORD="$(openssl rand -base64 18)"

# 3) build once, then run the browser suite (playwright starts `next start` itself)
npm run build
npx playwright install --with-deps chromium   # first time only
npm run test:e2e
```
Expect the `authenticated first-value journey` describe block to RUN (not skip): sign-in → onboarding
→ first task persisted, plus the existing public/accessibility/overflow specs. That is the evidence
LB-005 asks for.

> Safety: the spec hard-refuses a non-local Supabase unless `E2E_ALLOW_REMOTE_SUPABASE=1`. **Do not
> set that against prod** — the journey creates accounts/data. Always run it against `supabase start`
> (local) or an isolated project.

## Exit criteria / what to record

- `npm run test:e2e` with `E2E_AUTHENTICATED=1` passes the authenticated describe block with **no
  unexplained skips** (the only acceptable skip is when the flag is intentionally off).
- Attach the Playwright run summary as the LB-005 evidence and flip it to Resolved.

## Dependency

- **LB-015 (CI infra) gates the *automated* evidence** — once runners are back, the e2e job runs this
  on every push with zero extra setup. Until then, run it locally per above to unblock the launch
  decision. No new secrets or prod credentials are required either way.
