# Change Log

Session change log (all lanes, newest first). Full history: `git log`.
Narrative records per feature: `todo.md` + `docs/AGENT_HANDOFF.md`.

```
35928f0 2026-07-12 prevent external auth redirects
31465e8 2026-07-12 stabilize production browser validation
4dd75d5 2026-07-12 remove synthetic blog pages and stabilize tests
98a62cb 2026-07-12 harden production quality and seed guarantees
4704548 2026-07-12 feat(marketplace): Community Circles — cross-family marketplace v1 (backlog #21)
1aa63e4 2026-07-12 feat(marketplace): real AI assistant in the rail (backlog #11)
60937e6 2026-07-12 feat(marketplace): "Post in under 60 seconds with AI" (backlog #10)
0315c8a 2026-07-12 feat(marketing): abandoned-journey recovery beyond checkout (backlog #15) (#318)
5cf986d 2026-07-12 feat(onboarding): time-to-value audit dashboard (backlog #9) (#317)
4f76e30 2026-07-12 feat(ui): app-wide role density + Display comfort (backlog #8, slice 5) (#316)
b5d013b 2026-07-12 feat(marketing): Visitor Intelligence funnel dashboard (backlog #23) (#315)
6294e8e 2026-07-12 feat(marketing): transparent lead scoring (backlog #14) (#314)
ae2024c 2026-07-12 feat(marketing): progressive-profiling capture (backlog #13) (#313)
7dcf935 2026-07-12 feat(marketing): identity stitch on signup/login (backlog #6) (#312)
b7e24ae 2026-07-12 feat(privacy): consent banner + preference center (backlog #4) (#311)
a2ba89f 2026-07-12 feat(contacts): AI reconnect-message — "AI writes it for you" on the timeline (#310)
c0b9fcb 2026-07-12 feat(wallet): complete open-item #5 — Issuing cards to the key boundary
578a5d2 2026-07-12 feat(paperwork): AI draft-reply — "AI fills it out for you" (industry-first #4)
e235399 2026-07-12 feat(sync): complete open-item #3 — provider calendar two-way sync to the key boundary
de6e16d 2026-07-12 docs(todo): mark Chief-of-Staff front door assembled (f03500f)
f03500f 2026-07-12 feat(home): Chief-of-Staff front door — one-tap approvals + full staff report
c8452c9 2026-07-12 feat(offline): offline mode v1 — read cache + auto-resync + banner (gap #13)
3b078ce 2026-07-12 fix(security): stone-turn pass — Twilio callback auth, fail-closed escalate, tracker rate limit, dead links
4bcfc8c 2026-07-12 feat(ui): second-pass upgrades on the 2-star cohort (payments, family-signals)
7e975dd 2026-07-12 docs(handoff): UI/UX designer-pass block — 136-page audit + 3 premium rebuilds
41ceafb 2026-07-12 feat(ui): site-wide UI/UX audit + premium upgrades (Profile, Security, Dining)
f75eac9 2026-07-12 feat(autonomy): the Autonomous Execution Loop — accepted plans execute themselves
c5a5c49 2026-07-12 fix(seeds): restore seed_paperwork in SEED_ALL + Front Desk entry + handoff
9f4cb20 2026-07-12 copy(pricing): demo button — "Click to Demo Now"
3dadf66 2026-07-12 feat(contacts): per-contact Relationship Timeline + health (#309)
979deb8 2026-07-12 Add files via upload
f04962e 2026-07-12 feat(paperwork): Paperwork Inbox — AI triage for forms, slips & flyers (#308)
5b96e58 2026-07-12 feat(finance): Financial Copilot — schedule↔money cash-flow timeline
add2329 2026-07-12 docs: competitor-gap matrix in todo.md + handoff + pending migrations 0166/0167
6eb3165 2026-07-12 feat(calendar): busy-week heat map (TimeTree gap #16)
55a807f 2026-07-12 feat(independence): child independence progression ladder (Hearth gap #19)
fca8b04 2026-07-12 feat(workload): household workload balancing + analytics (Hearth gap #3/#4)
d68156f 2026-07-12 docs(handoff): App Store shipped (#10) — next lane = deepen the ◐ partials
5c30d6d 2026-07-12 feat(app-store): Family App Store — industry-first #10 (catalog + installs)
e3eae17 2026-07-12 docs: industry-first feature gap matrix + Family App Store build spec
8583cc7 2026-07-12 feat(demo): high-volume Bubaly demo — 200 rows per surface, PG16-validated
6f97ce6 2026-07-12 feat(concierge-calls): outbound "Bubaly calls for you" — full vertical slice
26a766b 2026-07-12 fix(seed): economy_redemptions uses only economy-valid statuses (prod 23514)
115deb0 2026-07-12 docs(handoff): record Messages + Calendar deep dives + 0163
d2c36f6 2026-07-12 fix(catchup): dedupe before every unique index so prod dup data can't block it (23505)
602f985 2026-07-12 fix(catchup): drop legacy CHECK constraints on drifted support_tickets (prod 23514) (#305)
a26b6f5 2026-07-12 fix(catchup): reconcile drifted support_tickets shape (prod 42703) (#304)
4782020 2026-07-12 fix(catchup): remove malformed 'drop trigger ... on public' injections (prod 42P01) (#303)
26e55e6 2026-07-12 chore(migrations): renumber trial migration 0161→0164 (demo collision) + handoff
60b2e57 2026-07-12 Merge pull request from NewWorldVenture/claude/trial-lockdown-close-account
e4dc050 2026-07-12 feat(billing): 5-day free trial → paywall lockdown + soft account closure
f8dfdb2 2026-07-11 feat(db): idempotent CATCH_UP_PROD.sql — reconcile a behind prod DB (all 181 migrations) (#288)
60d9478 2026-07-11 feat(demo): add Google + Apple sign-in to the demo email gate (#293)
3129f7c 2026-07-11 docs(handoff): record round-5 seed coverage — sweep complete (#302)
9fa5291 2026-07-11 feat(seed): cover 9 more left-nav tables (loyalty, weather, pay handles, AI chat) — PG16-validated (#301)
fa85642 2026-07-11 docs(handoff): record round-4 seed coverage (#300)
89eb4b8 2026-07-11 feat(seed): cover 13 more left-nav tables — PG16-validated (#299)
5fec7c8 2026-07-11 docs(handoff): mark feature-gaps-3 seed PG16-validated (#298)
8f7f7ef 2026-07-11 fix(seed): make feature-gaps-3 actually run — PG16-validated, 3 real bugs (#297)
1f47edd 2026-07-11 feat(seed): cover 20 user-facing left-nav tables that rendered empty (#296)
aa05d98 2026-07-12 fix(calendar): recurring events actually recur + events can be edited/deleted
d55ade4 2026-07-12 fix(messages): voice notes never saved + read receipts wiped each other
3d3ffd6 2026-07-12 feat(nav-sweep): close the last nav stub — key-gated GIF picker + handoff update
242a61f 2026-07-12 fix(onboarding): full-section audit — reachability, replay safety, welcome email
c811532 2026-07-12 fix(demo): full-section audit — close login, gating, and abuse gaps
```
