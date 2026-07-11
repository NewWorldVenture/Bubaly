# One-click demo ("Test Account → Login Now to Try Me")

A no-signup way to try the whole product. From **/pricing**, the **Test Account**
card's button provisions a throwaway **Family+** account, signs the visitor
straight in, runs a **5-minute** countdown, and **fully resets** (deletes
everything) when they leave — so it's fresh for the next person. Each click gets
its **own** ephemeral family, so concurrent testers never collide.

## Flow
1. **`startDemoAction`** (`app/(marketing)/demo/actions.ts`): reaps expired demos,
   then `startDemoSession()` creates a new auth user (synthetic `demo-…@demo.bubaly.app`),
   a **Family+** family (subscription `plan='plus'` → full capabilities), seeds a
   believable dataset (`lib/demo/seed.ts`), and writes a `demo_sessions` row that
   expires in 5 min. It signs the user in (cookie) and redirects to `/home`.
2. **Countdown** (`components/demo/demo-timer.tsx`): a sticky top banner shows the
   remaining time (turns red under a minute). `AppFrame` reads `demo_sessions` for
   the signed-in user and passes `demoExpiresAt` into the app context.
3. **Teardown** happens three ways, all via `endDemoSession()` (delete the family
   → cascades all its data; delete the auth user → cascades membership / prefs /
   the `demo_sessions` row):
   - the timer hits **0:00**,
   - the visitor clicks **Exit**,
   - the **`/api/cron/demo-cleanup`** cron (every 15 min) reaps abandoned tabs.

## Isolation & safety
- Each demo is a separate auth user + family (RLS-isolated); never a super-admin.
- Synthetic address is never emailed; credentials are random, server-side only.
- `startDemoAction` reaps expired demos on every start, bounding growth.

## Owner steps to activate
1. Apply migration **`0138_demo_sessions.sql`** (`supabase db push`).
2. `CRON_SECRET` must be set (already required by the other crons) for the
   cleanup cron.
No other keys — the demo runs entirely on the service-role client already used
for family provisioning.
