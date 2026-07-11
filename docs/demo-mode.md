# One-click demo ("Demo Account → Login Now to Try Me")

A no-signup way to try the whole product. From **/pricing**, the **Demo Account**
card's button signs the visitor into **one single, shared demo account** —
"**Bubaly Demo**", a full **Family+** family. There is exactly **one** demo user
(no throwaway per-visitor accounts). Every login **resets it to a fresh,
fully-seeded state** (~200 rows across every surface), so each visitor starts on a
pristine demo. The app opens **behind a blurred email-capture pop-up**; once they
enter an email, a **5-minute** countdown starts. When it runs out, the app blurs
again behind an **upgrade pop-up** (Free 5-day trial / Family Basic / Family+).

## The single account
- **One** auth user `demo@demo.bubaly.app` (`full_name = "Bubaly Demo"`) and **one**
  family named **"Bubaly Demo"**. The family is looked up by that exact name — only
  the demo ever creates it — so it is reused, never duplicated.
- `ensureDemoAccount()` (`lib/demo/session.ts`) get-or-creates the user, family,
  owning member, **Family+** subscription and active-family preference (first run
  only). `resetDemoData()` wipes the seed-scoped tables and re-seeds via
  `seedDemoFamily()` on every login.
- No stored password: each login rotates the shared password server-side (with a
  one-shot retry to absorb a concurrent-login race), then signs the visitor in.

## Flow
1. **`startDemoAction`** (`app/(marketing)/demo/actions.ts`): `startDemoSession()`
   ensures the "Bubaly Demo" account exists, **resets its data** to a fresh seed,
   rotates the password, and writes its `demo_sessions` row with **`expires_at =
   null`** (clock not started). It signs the user in (cookie) and redirects to
   `/home`.
2. **Email gate** (`components/demo/demo-experience.tsx`): while `expires_at` is
   null the app is blurred behind a pop-up that captures the visitor's email.
   Submitting calls **`startDemoClockAction`**, which stamps `email` and sets
   `expires_at = now + 5 min` — re-rendering `/home` lifts the blur.
3. **Countdown**: a sticky top banner shows the remaining time (turns red under a
   minute). `AppFrame` reads `demo_sessions` for the signed-in user and passes a
   `demo` object (`{ expiresAt }`) into the app context.
4. **Ended**: at `0:00` the same component blurs the app behind an **upgrade
   pop-up**. Choosing a plan calls **`choosePlanAfterDemoAction`**, which signs out
   + clears the session row and redirects into signup: **Free** → `/signup` (5-day
   trial), **Family Basic** → `/signup?plan=basic`, **Family+** → `/signup?plan=plus`.
5. **Session end** (Exit button, upgrade choice, or the expiry cron) calls
   **`endDemoSession()`**, which only **clears the `demo_sessions` row**
   (`expires_at`/`email` → null) so the next visitor starts behind a fresh gate.
   The shared account and its data are **never deleted** — the next login re-seeds
   them clean.

## Isolation & safety
- The demo family is RLS-isolated like any other family; the demo user is never a
  super-admin. The synthetic address is never emailed.
- Credentials are random and rotated per login, server-side only.
- The captured email is stored on the `demo_sessions` row (lead capture) — it is
  not the login and is never emailed by the demo itself.
- Because everyone shares one account, concurrent visitors share its live data;
  each new login re-seeds it, so it self-heals to a clean state.

## Owner steps to activate
1. Apply migrations **`0138_demo_sessions.sql`** and
   **`0161_demo_session_email_gate.sql`** (`supabase db push`). No new migration is
   needed for the single-account model — it reuses the existing `demo_sessions`
   schema.
2. `CRON_SECRET` must be set (already required by the other crons) for the
   cleanup cron.
No other keys — the demo runs entirely on the service-role client already used
for family provisioning.
