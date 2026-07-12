# Onboarding — profile, role, marketing engine & child logins

End-to-end audit + hardening of the bubaly.com onboarding flow.

## The flow (post sign-up)
Signup (password or OAuth, incl. the email-confirmation callback) routes to
**`/onboarding`** → the six-step `OnboardingWizard` (resumable via a
sessionStorage draft; nothing is written until Finish):
1. **Profile** — avatar, name, age, colour.
2. **Family** — name your shared space (timezone auto-detected).
3. **Value** — paste a calendar (.ics) or try the sample week → the instant
   "first brief" payoff (today's timeline, clashes, dinner ideas, time saved).
4. **About** — household makeup, goals, referral source (skippable).
5. **Members** — add people / invite by email (skippable).
6. **PIN** — optional App Lock seed (skippable) → celebratory Done screen.

One atomic action, **`finalizeOnboardingAction`**, writes it all: profile →
family (service-role insert; explicit owner-member upsert — never trusts the
`handle_new_family` trigger) → trial subscription → active family →
questionnaire (`family_onboarding`) → local members + email invites → imported
calendar events + the durable `onboarding_imports` TTFV record → age/PIN/flag in
`user_preferences.notification_prefs` → audit → marketing. It is **replay-safe**:
if the caller already belongs to a family, an auto-provisioned space is
*adopted* (renamed to the wizard's name) and anything else short-circuits as an
idempotent re-submit — a double-click or replayed request can never mint a
second family. Both completion paths also send the branded **welcome email**
(`lib/emails/welcome.tsx`, best-effort).

The lightweight `completeProfileOnboardingAction` (profile + PIN only) and
`saveFamilyDetailsAction` (used by `/dashboard/setup`) remain available and are
wired to the same marketing + lifecycle plumbing.

## Lifecycle + re-onboarding (migration 0159)
Every completion records a durable **`onboarding_progress`** row (one per
account): status (`in_progress`/`completed`/`reset`), source
(`wizard`/`auto_provision`), value-step engagement, goals/referral/household,
and a 0–100 completeness score (`lib/onboarding/completeness.ts`, pure +
tested). This makes the previously-invisible **auto-provisioned cohort** (users
`ensureActiveFamily` gave a space to without the wizard) queryable and drives:
- **`/dashboard/setup`** — the re-onboarding surface (live score, what's-left
  checklist, questionnaire against the EXISTING family) + `resetOnboardingAction`.
- The **home "finish setting up" nudge** — managers with an incomplete account
  see a banner on `/home` linking to `/dashboard/setup` (gated by one indexed
  read of the lifecycle row, so completed accounts pay ~nothing).

## Marketing engine wiring (new)
Every completed onboarding now **feeds the marketing engine**:
- **`lib/marketing/onboarding-contact.ts` → `upsertOnboardingContact`** creates/
  enriches a **`crm_contacts`** row (deduped by email, then family) with
  `lead_status='customer'`, `lifecycle_stage='customer'`, `lead_source`, the
  `family_id`, and marketing attributes (role=parent, age, goals, referral
  source, household makeup) as JSON in `notes`. So the account holder is
  immediately segmentable/targetable.
- **`fireAutomationEvent('onboarding_completed')`** now fires from the **active**
  lightweight flow (`completeProfileOnboardingAction`) — previously only the
  fuller flow fired it — so the welcome automation runs for everyone.
Both are best-effort (wrapped in try/catch; never block finishing onboarding),
run through the service-role client, and are idempotent (dedup by contact +
`marketing_automation_runs` unique `(workflow_id, subject_key)`).

No migration — `crm_contacts` and the `marketing_automation_*` tables already exist.

## Child logins — no email required (new)
A parent can give a child their own account they sign into with **username +
4-digit PIN**, no email. The child gets a real Supabase Auth user under a
synthetic (never-emailed) address, and their `family_members.user_id` is linked
to it — so once signed in they ARE their member (chores, rewards, `/kids`).

**Files**
| File | Role |
|---|---|
| `supabase/migrations/0105_child_logins.sql` | `child_logins` map (family/member/user/username) + RLS + indexes |
| `lib/onboarding/child-login.ts` | pure, client-safe helpers (username, synthetic email) |
| `lib/onboarding/child-password.ts` | **server-only** PIN→password derivation (node:crypto) |
| `app/(app)/family/child-login-actions.ts` | `createChildLoginAction`, `resetChildPinAction` (manager-guarded, service role) |
| `app/(auth)/actions.ts` → `childSignInAction` | public username+PIN sign-in (sets the session) |
| `app/(auth)/kid-login/page.tsx` + `components/auth/kid-login-form.tsx` | the Kid sign-in screen (`/kid-login`) |
| `app/(app)/dashboard/family-access/page.tsx` + `components/family/child-access-manager.tsx` | parent management: create / reset (also in All Services → "Kid Logins") |

**Security**
- `deriveChildPassword(secret, username, pin)` = `sha256(secret::username::pin)`,
  so the 4-digit PIN alone can't be brute-forced offline; the server secret is
  never exposed. Requires the **`CHILD_LOGIN_SECRET`** env var — the create/sign-in
  actions no-op with a clear message until it's set.
- All creation/reset asserts `isManager(role)` AND runs via the service role;
  `child_logins` RLS lets family members read, managers manage; no public read.
  Sign-in failures are deliberately vague (no username enumeration).
- `family_members.user_id` is set to the child's auth user; the DB column allowed
  it — the generated Update type was extended to match.

**Login link:** `/login` now shows "Kid logging in? Use your username & PIN" → `/kid-login`.

## Setup / run
1. Apply migrations: `supabase db push` (adds `0105_child_logins.sql`).
2. Set env: **`CHILD_LOGIN_SECRET`** (a long random string) in the server
   environment (Vercel project env). Without it, child logins are disabled with a
   visible notice.
3. (Marketing) ensure the `onboarding_completed` automation workflow is `active`
   in Admin → Marketing → Automation to actually send the welcome email.

## Local QA checklist
- Sign up fresh → `/onboarding` → finish → land on `/home`; confirm you're the
  **parent** member and (as an admin) a `crm_contacts` row exists for you with
  `lead_source` and attributes.
- As a parent, open **All Services → Kid Logins** (`/dashboard/family-access`),
  create a login for a child (username + PIN).
- Open `/kid-login` in a private window, sign in with that username + PIN → the
  child lands in their own Bubaly.
- Reset the PIN from the management page → old PIN fails, new one works.

## Known limitations
- Child sign-in is throttled app-side per username (`child_login_throttle`,
  migration 0137 — lockout after repeated failures) on top of Supabase Auth's
  own rate limiting.
- The lightweight `completeProfileOnboardingAction` path doesn't collect
  goals/referral; those accounts show the home "finish setting up" nudge and can
  complete the questionnaire at `/dashboard/setup`.
