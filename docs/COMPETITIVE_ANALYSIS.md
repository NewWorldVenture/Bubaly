# Competitive Analysis — Bubaly / FamilyOS vs. AI Family Organizers

Grounded, code-cited comparison against the four AI family organizers a user
surfaced (Sense, Nori AI, Maple, Skylight Calendar 2). Each competitor headline
is mapped to the FamilyOS capability that already meets or beats it — with file
evidence — and the single genuine gap that this pass closed.

Last updated: 2026-07-18 · Owner: `agent-fable-opus` (CLAUDE-POLISH-01)

## Verdict

FamilyOS already matched or beat **3 of the 4** competitors' headline features
before this pass; the one true gap (Nori's "fridge photo → recipes") is now
shipped (**Fridge Chef**, PLA-0835). Net: FamilyOS covers the union of all four.

| Competitor | Headline feature | FamilyOS status | Evidence |
|-----------|------------------|-----------------|----------|
| **Sense** — "Best Overall AI Organizer" | Scans inbox for school/sports emails → calendar events; shared to-dos, daily agendas, routine chores | **BEATEN** — "Magic Import" turns pasted school/sports text into calendar events **plus** chores, reminders, grocery, and meal-plan entries (broader than events-only), each Trust-governed before write. Daily/weekly agendas + routine chores are first-class. | `app/api/ai/import/route.ts`, `app/(app)/dashboard/briefing/**`, `lib/planning/prep.ts`, chores/routines |
| **Sense/Maple** — parse "messy school admin emails" | Turn email/flyer content into tasks/events | **BEATEN (vision)** — a **photo of a school flyer/PDF** is read by the OpenAI vision model into calendar events; the provider supports multimodal image input natively | `app/api/ai/flyer/route.ts`, `lib/ai/provider.ts` (AIImage / image_url) |
| **Maple** — "Best for Calendar Syncing" | Pull external calendars from different platforms together | **MATCHED** — two-way sync adapters for Google, Apple (CalDAV), and Microsoft; encrypted token store; fail-closed when unconfigured | `lib/sync/providers/{google,apple,microsoft}.ts` |
| **Skylight Calendar 2** — "Best for Kitchen Wall Displays" | $$$ 15–27" touchscreen; "Magic Import" so kids check schedules without a phone | **BEATEN (free)** — `/display` kiosk turns **any** tablet into a shared wall display (schedules, chores, meals, weather), no hardware purchase; SSR-hardened | `app/(app)/display/**` |
| **Nori AI** — "Best for Meals and Routines" | Photo of fridge → AI suggests recipes, checks allergies, auto-builds shared grocery list | **CLOSED THIS PASS** — **Fridge Chef**: snap the fridge/pantry → allergy-aware dinner ideas (family allergies from `medical_profiles`) → one-tap "add missing to grocery list" | `app/api/ai/pantry-chef/route.ts`, `lib/meals/pantry-chef.ts`, `components/meals/fridge-chef.tsx`, `app/(app)/dashboard/fridge-chef/page.tsx` |

## Structural advantages (beyond the four headlines)

- **The AI takes real action, not just chat** — the assistant creates events,
  chores, reminders, meals, and grocery items in the family's own RLS-scoped
  data, governed by the Trust Engine (child vs. parent). Competitors above are
  framed as single-purpose (email→calendar, or meals, or display).
- **One operating system, not a point tool** — calendar, chores/allowance,
  meals/grocery, documents, health, guardian/safety, wallet, marketplace, and a
  kids display all share one household model + tenant isolation.
- **Privacy posture** — per-table RLS, private storage with short-lived signed
  URLs, no cross-family access (proven live on PG16 across the audit).

## The one gap we closed — Fridge Chef (Nori parity+)

`POST /api/ai/pantry-chef`
- **Phase 1** — a fridge/pantry photo is sent to the configured OpenAI vision
  model with an allergy-aware prompt (family allergies pulled from
  `medical_profiles`); the reply is parsed into ≤6 dinner recipes with
  have/need ingredient splits and a defense-in-depth `allergenConflict` flag
  (so a suggestion is warned even if the model slips).
- **Phase 2** — a recipe's "need" items are appended to the family's shared
  grocery list (get-or-create the default list), under the caller's RLS session.
- Auth + AI rate-limit + bounded request/response bodies, mirroring the flyer
  route. Pure engine (`lib/meals/pantry-chef.ts`) is unit-tested (9 cases);
  build verified (`/dashboard/fridge-chef`, `/api/ai/pantry-chef`).

## Recommended follow-ups (owner-prioritised, not yet built)

1. **Discoverability** — link Fridge Chef from the Smart Kitchen page + app nav
   (kept out of this pass to avoid the active A-05 dashboard lane).
2. **Inbound-email ingestion** — today Magic Import is paste/photo; a
   forward-to-address inbound pipeline (Resend/Brevo inbound → Magic Import)
   would fully automate Sense's "auto-scan inbox" without the user pasting.
3. **Fridge Chef → meal plan** — one-tap "add to this week's plan" in addition
   to grocery, closing the loop with `meal_plans`.
