# One-click demo ("Demo Account → Login Now to Try Me")

A no-signup way to try the whole product. From **/pricing**, the **Demo Account**
card's button signs the visitor into **one single, shared demo account** —
"**Bubaly Demo Account**" (`demo@demo.bubaly.app`), a full **Family+** family.
There is exactly **one** demo user (no throwaway per-visitor accounts). Every
login **resets it to a fresh, fully-seeded state** (~200 rows across every
surface), so each visitor starts on a pristine demo. The app opens **behind a
blurred email-capture pop-up**; once they enter an email, a **5-minute**
countdown runs top-left in the header. When it hits zero, the app blurs again
behind an **upgrade pop-up** (Free 5-day trial / Family Basic / Family+). Each
email gets **one demo** — a repeat is routed to **/demo/upgrade** instead.

## The single account
- **One** auth user `demo@demo.bubaly.app` and **one** family named
  **"Bubaly Demo Account"**. `ensureDemoAccount()` (`lib/demo/session.ts`)
  resolves it by the **stable key first — the auth user's email** — then the
  family via the user's oldest membership, and **self-heals the family name**
  back to the canonical one (a demo visitor has parent rights and can rename it;
  a name-only lookup used to mint a duplicate family on every rename). Name
  lookup (current + legacy "Bubaly Demo") remains a fallback; the create path
  runs first-run only (user, family, owning member, Family+ subscription,
  active-family preference).
- `resetDemoData()` wipes the seed-scoped tables (children before parents) and
  re-seeds via `seedDemoFamily()` on every login. Every table `seedDemoFamily`
  writes MUST be in `SEED_TABLES`, or data accumulates across resets.
- No stored password: each login rotates the shared password server-side (with a
  one-shot retry to absorb a concurrent-login race), then signs the visitor in.
- Home greets the demo family by name: **"Welcome Bubaly Demo Account"**.

## Flow
1. **`startDemoAction`** (`app/(marketing)/demo/actions.ts`): `startDemoSession()`
   ensures the account exists, **resets its data** to a fresh seed, rotates the
   password, and writes its `demo_sessions` row with **`expires_at = null`**
   (clock not started). It signs the user in (cookie) and redirects to `/home`.
2. **Email gate** (`components/demo/demo-experience.tsx` → `DemoEmailGate`):
   while `expires_at` is null the app is blurred behind a pop-up that captures
   the visitor's email. Submitting calls **`startDemoClockAction`**, which:
   - requires a live `demo_sessions` row (any signed-in user can invoke a server
     action — non-demo callers are bounced to `/home` untouched);
   - validates the email server-side (`isLikelyEmail` — the form's `required` is
     client-only), re-rendering the gate on garbage input;
   - enforces **one demo per email**: `demo_email_uses` (migration 0162) records
     each email's FIRST demo window (insert-only / `ignoreDuplicates`, so
     re-entering can't extend it); once that window has passed
     (`isDemoEmailUsedUp`), the visitor is signed out and routed to
     **/demo/upgrade**;
   - stamps `email` + `expires_at = now + 5 min`, records the allowance, and
     feeds marketing: `captureDemoLead()` (`lib/demo/lead.ts`) upserts a durable
     `crm_contacts` lead (`lead_source: 'demo'`) and fires the `demo_started`
     automation event (idempotent per email) so any active demo follow-up
     campaign runs.
3. **Countdown**: `DemoClockPill` — a compact pill pinned **top-left in the app
   header** — ticks every second (red + pulsing in the final minute) with an
   Exit button. `AppFrame` reads `demo_sessions` for the signed-in user
   (try/catch — a missing table degrades to "not a demo") and passes
   `{ expiresAt }` into the app context.
4. **Ended**: at `0:00` the pill swaps for the blurred **upgrade pop-up**.
   Choosing a plan calls **`choosePlanAfterDemoAction`** (signs out + clears the
   session row): **Free** → `/signup` (5-day trial); **Basic / Family+** →
   `/signup?plan=…&redirect=/dashboard/billing?view=manage&checkout=…` — after
   account creation, the billing manager **auto-opens Stripe Checkout** for the
   chosen plan.
5. **Repeat visitor** (used-up email): the gate routes to **/demo/upgrade**
   ("You've already used your free demo") with the same three plan choices.
6. **Session end** (Exit button, upgrade choice, or the 15-minute cleanup cron
   `/api/cron/demo-cleanup`) calls **`endDemoSession()`**, which only **clears
   the `demo_sessions` row** (`expires_at`/`email` → null) so the next visitor
   starts behind a fresh gate. The row is deliberately never DELETED on expiry:
   with one shared row, deletion would read as "not a demo" for a visitor still
   holding the session — dropping the blur entirely.

## Isolation & safety
- The demo family is RLS-isolated like any other family; the demo user is never
  a super-admin. The synthetic address is never emailed by the demo itself.
- Credentials are random and rotated per login, server-side only.
- Renames/deletions by a demo visitor self-heal on the next login (email-first
  resolution + name heal + create-what's-missing).
- Because everyone shares one account, concurrent visitors share its live data;
  each new login re-seeds it, so it self-heals to a clean state.
- One-per-email gating is honesty-level enforcement (a different address gets a
  fresh demo) — it stops casual repeats, not determined abuse.

## Owner steps to activate
1. Apply migrations **`0138_demo_sessions.sql`**,
   **`0161_demo_session_email_gate.sql`** and **`0162_demo_email_uses.sql`**
   (SQL editor paste — note the 0138 number collision with
   `0138_onboarding_imports.sql` if using `supabase db push`; see
   `docs/PENDING_PROD_MIGRATIONS.md`).
2. `CRON_SECRET` must be set (already required by the other crons) for the
   cleanup cron.
3. Optional: create an active marketing workflow on the **`demo_started`**
   trigger so captured demo emails get the follow-up campaign.

No other keys — the demo runs entirely on the service-role client already used
for family provisioning.
