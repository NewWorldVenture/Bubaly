# One-click demo ("Test Account → Login Now to Try Me")

A no-signup way to try the whole product. From **/pricing**, the **Test Account**
card's button provisions a throwaway **Family+** account and signs the visitor
straight in. The app then opens **behind a blurred email-capture pop-up**; once
they enter an email, a **5-minute** countdown starts. When it runs out, the app
blurs again behind an **upgrade pop-up** (Free 5-day trial / Family Basic /
Family+). The demo **fully resets** (deletes everything) when they leave — so it's
fresh for the next person. Each click gets its **own** ephemeral family, so
concurrent testers never collide.

## Flow
1. **`startDemoAction`** (`app/(marketing)/demo/actions.ts`): reaps expired demos,
   then `startDemoSession()` creates a new auth user (synthetic `demo-…@demo.bubaly.app`),
   a **Family+** family (subscription `plan='plus'` → full capabilities), and seeds
   a believable dataset (`lib/demo/seed.ts`). It writes a `demo_sessions` row with
   **`expires_at = null`** (clock not started), signs the user in (cookie), and
   redirects to `/home`.
2. **Email gate** (`components/demo/demo-experience.tsx`): while `expires_at` is
   null the app is blurred behind a pop-up that captures the visitor's email.
   Submitting calls **`startDemoClockAction`**, which stamps `email` and sets
   `expires_at = now + 5 min` — re-rendering `/home` lifts the blur.
3. **Countdown**: a sticky top banner shows the remaining time (turns red under a
   minute). `AppFrame` reads `demo_sessions` for the signed-in user and passes a
   `demo` object (`{ expiresAt }`) into the app context.
4. **Ended**: at `0:00` the same component blurs the app behind an **upgrade
   pop-up**. Choosing a plan calls **`choosePlanAfterDemoAction`**, which tears the
   demo down and redirects into signup: **Free** → `/signup` (5-day trial),
   **Family Basic** → `/signup?plan=basic`, **Family+** → `/signup?plan=plus`.
5. **Teardown** happens several ways, all via `endDemoSession()` (delete the family
   → cascades all its data; delete the auth user → cascades membership / prefs /
   the `demo_sessions` row):
   - an **upgrade** choice after the clock ends,
   - the visitor clicks **Exit** on the banner,
   - the **`/api/cron/demo-cleanup`** cron (every 15 min) reaps expired demos **and**
     abandoned, never-started ones (`expires_at` null, created > 30 min ago).

## Isolation & safety
- Each demo is a separate auth user + family (RLS-isolated); never a super-admin.
- Synthetic address is never emailed; credentials are random, server-side only.
- The captured email is stored on the `demo_sessions` row (lead capture) — it is
  not the login and is never emailed by the demo itself.
- `startDemoAction` reaps expired + abandoned demos on every start, bounding growth.

## Owner steps to activate
1. Apply migrations **`0138_demo_sessions.sql`** and
   **`0161_demo_session_email_gate.sql`** (`supabase db push`).
2. `CRON_SECRET` must be set (already required by the other crons) for the
   cleanup cron.
No other keys — the demo runs entirely on the service-role client already used
for family provisioning.
