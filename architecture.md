# Architecture

## Stack
- **Next.js 15 App Router** (TypeScript, `nodejs` runtime for API routes). Route groups:
  `(marketing)` public site, `(app)` authenticated product (dashboard/wallet/money/admin).
- **Supabase**: Postgres + Auth + Realtime + Storage. Hand-maintained types in
  `lib/database.types.ts` (`T<Row,Insert,Update>` triples + `Stamps` mixin).
- **Capacitor** mobile shell (`lib/native`); PWA push (`lib/push`).
- **Stripe**: billing (checkout/webhooks) + Bubaly Money (Connect/Treasury/Issuing,
  separate `/api/webhooks/money` endpoint, capability-gated via `lib/stripe/capabilities.ts`).
- **AI**: provider-agnostic via `lib/ai/*` (key-gated `isAIConfigured` with honest fallbacks);
  per-feature AI routes under `/api/ai/*`, all rate-limited.

## Layering conventions
1. **Pure engines** in `lib/<feature>/*.ts` — deterministic, no I/O, unit-tested (Vitest).
2. **Server pages** (`app/(app)/dashboard/<x>/page.tsx`) — `requireUserContext()`, fetch, pass
   plain props. Server actions in sibling `actions.ts` (validated, audited via `logAudit`).
3. **Client modules** (`components/modules/*-module.tsx`) — `useRealtimeQuery` (family-scoped
   realtime + offline read-cache), shared primitives (PageHeader, stat-card, Modal, toast).
4. **API routes** — auth via `requireUserContext`/`CRON_SECRET`/webhook signatures/internal
   secrets; public trackers rate-limited per IP.

## Security model
- Family-scoped RLS everywhere via `public.is_family_member(family_id)`; universal RLS enable +
  drift healing in migration 0118. Service-role only server-side.
- Sync provider tokens AES-256-GCM (`lib/sync/crypto.ts`, `SYNC_TOKEN_KEY`, fail-closed).
- Twilio callbacks signature-validated; Stripe webhooks signature-validated + idempotent
  (`stripe_webhook_events` ledger).

## Key subsystems
- **Two-way provider sync (R9)**: `lib/sync/adapter.ts` contract → `lib/sync/providers/*`
  (google, microsoft) → `lib/sync/engine/generic.ts`; generic OAuth routes
  `/api/sync/[provider]/*`; scheduled `/api/cron/provider-sync`.
- **Bubaly Money**: immutable ledger (`wallet_transactions`), real-time card authorization
  (atomic reserve in `lib/wallet/server.ts`), Issuing cards + PAN reveal via Stripe Elements.
- **Reasoning/intelligence**: knowledge graph, digital twin, operating index, calm inbox,
  signals — engine-driven server pages snapshotting daily.
- **Offline v1**: localStorage read-cache in `useRealtimeQuery` + `OfflineBanner`; cache wiped
  on sign-out.

## Migration + seed discipline
Additive/idempotent migrations, PG16-validated twice pre-merge (throwaway cluster). Seeds
paste-ready, idempotent, tagged (`[seed:x]`), resolve family by email, appended to SEED_ALL.sql.
