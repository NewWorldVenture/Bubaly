# Marketing Platform Coordination

**Purpose:** shared ownership contract for parallel Codex/Claude work on the AI-first marketing operating system.

**Updated:** 2026-07-18 11:58 America/New_York
**Repository:** `NewWorldVenture/FamilyOS`
**Current integration branch:** `codex/reasoning-main-publication`
**Baseline:** `a6ca111e`
**Next migration number:** `0232` (migration `0231_marketing_platform_spine.sql` is committed locally and awaiting Supabase apply)
**Production runbook:** `docs/MARKETING_PLATFORM_PRODUCTION_RUNBOOK.md`

## Rules

1. Before editing, read this file and `git status --short --branch`.
2. Claim one lane by adding a row to the ownership table below. A claim owns file paths, not just a feature name.
3. Do not edit another active lane's files. If a shared integration is needed, add a note to **Integration requests** and keep working in your own files.
4. Use a `codex/` or `claude/` branch. Do not push directly to `main`.
5. Every lane must add focused tests and run typecheck before handoff. The integration owner runs the full gate after merges.
6. Never reuse a migration number. A migration must include RLS, grants/policies, rollback notes, and a production verification query.
7. Marketing data is admin-owned through `requireMarketingAdmin()` and the service client. Public reads must be explicitly limited to published, non-deleted records.
8. Images and videos require provenance. Use the Asset Library, keep a license/source/attribution record, and do not upload a content hash already present in Supabase. Do not add stock URLs without a documented license.

## Current Architecture

The platform spine is being built around these Supabase objects:

- `marketing_pages`: canonical page registry for landing, question, guide, comparison, alternative, audience, resource, glossary, feature, blog, and custom pages.
- `marketing_page_versions`: immutable editorial/generation snapshots.
- `marketing_content_templates` and `marketing_brand_rules`: reusable generation constraints.
- `marketing_generation_jobs`: idempotent, claimable queue for regeneration, questions, metadata, embeddings, provider refresh, and sitemap work.
- `marketing_embeddings`: vector records for semantic retrieval. Provider absence must be visible, never replaced with fabricated vectors.
- `marketing_provider_observations` and `marketing_provider_syncs`: Search Console, Bing, and AI-citation observations with explicit provider status.
- `/api/cron/marketing`: five-minute generation worker.
- `/api/cron/marketing-providers`: six-hour external analytics sync.
- `/admin/marketing/platform`: Super Admin control center for pages, templates, brand rules, queue health, and provider health.

## Ownership Board

| Lane | Owner | Status | Owned paths | Do not touch | Handoff evidence |
|---|---|---|---|---|---|
| Platform spine | `CODEX-01` | CHECKPOINT READY | `supabase/migrations/0231_marketing_platform_spine.sql`, `lib/database.types.ts`, `lib/marketing/platform.ts`, `lib/marketing/provider-sync.ts`, `lib/marketing/public-pages.tsx`, `app/api/cron/marketing/**`, `app/api/cron/marketing-providers/**`, `vercel.json`, `.env.example` | Other lanes' admin/public UI | Typecheck PASS; migration audit PASS; full suite PASS (632 files / 3,744 tests); build PASS; provider-key normalization and immutable-version policy contracts PASS |
| Super Admin control center | `MARKETING-ADMIN-02` | AVAILABLE AFTER SPINE CHECKPOINT | `app/(app)/admin/marketing/platform/**`, `app/(app)/admin/marketing/marketing-subnav.tsx` | `lib/marketing/platform.ts`, migration files | Admin action tests, role boundary test, rendered page smoke |
| Public page families | `MARKETING-PUBLIC-02` | AVAILABLE AFTER SPINE CHECKPOINT | `app/(marketing)/questions/**`, `guides/**`, `compare/**`, `alternatives/**`, `audiences/**`, `resources/**`, `glossary/**` | `lib/marketing/public-pages.tsx`, `app/sitemap.ts` | Public published/draft/404 tests, metadata, JSON-LD, mobile smoke |
| Public shared renderer | `MARKETING-PUBLIC-03` | RESERVED | `lib/marketing/public-pages.tsx` | Route folders owned by PUBLIC-02 | Renderer tests and accessibility check |
| Legacy content bridge | `CODEX-01` | CHECKPOINT READY | `app/(app)/admin/marketing/content/**`, `app/(app)/admin/marketing/actions.ts` (legacy marketing actions), `lib/marketing/legacy-bridge.ts` | Platform schema and worker internals | Blog/landing create, publish, edit, unpublish, archive bridge; missing-schema compatibility; full suite PASS |
| Provider analytics | `MARKETING-DATA-02` | AVAILABLE | `app/(app)/admin/marketing/seo/**`, `analytics/**`, `intelligence/**`, provider observation UI/tests | Provider adapter implementation | Fixture import tests, no-fabrication tests, degraded-state UI |
| Asset provenance | `MARKETING-ASSETS-02` | CHECKPOINT READY | `app/(app)/admin/marketing/assets/**`, `video/**`, `lib/marketing/assets.ts`, `lib/marketing/video.ts`, `scripts/backfill-marketing-asset-provenance.mjs`, `scripts/verify-marketing-assets-remote.mjs` | Platform worker and public route files | Local asset audit PASS (18 unique shipped raster assets; no remote image URLs); remote asset gate is ready and currently blocked only by unapplied 0231 |
| Test and verification | `MARKETING-QA-02` | CHECKPOINT READY | `tests/marketing-platform-*.test.ts`, `tests/marketing-provider-*.test.ts`, `tests/marketing-assets-*.test.ts` | Production code owned by another lane | Full suite PASS (632 files / 3,744 tests) |
| Integration owner | `CODEX-01` | ACTIVE | `docs/MARKETING_PLATFORM_COORDINATION.md`, release notes, final integration only | Active feature lanes before handoff | Full test, lint, typecheck, build, migration audit |

## Parallel Bot Roster

The three Claude bots should take one lane each and update the row before
touching files. These assignments are deliberately disjoint from Codex's
platform-spine files:

| Bot | Assigned lane | First deliverable | Protected files |
|---|---|---|---|
| `CLAUDE-MKT-ADMIN` | Super Admin control center | Polish `/admin/marketing/platform`, add role-boundary and action tests | `lib/marketing/platform.ts`, `0231_*`, worker routes |
| `CLAUDE-MKT-PUBLIC` | Public page families + legacy bridge | Add route fixtures, public accessibility/metadata coverage, then bridge legacy blog/landing edits | `lib/marketing/public-pages.tsx`, `app/sitemap.ts`, `0231_*` |
| `CLAUDE-MKT-DATA` | Provider analytics + asset provenance | Add fixture-backed provider dashboards and duplicate/license contract tests | `lib/marketing/provider-sync.ts`, `assets/actions.ts`, `video/actions.ts` |
| `CODEX-01` | Platform spine + integration | Finish worker/provider integration, migration verification, full gate | All protected files above; release only after bot handoffs |

Bot checkpoint comments must include the lane, exact files, tests, and any
integration request. A bot that needs a protected file must stop and request a
small interface change rather than editing around the ownership boundary.

### Claim protocol

To claim a lane, append a row with the agent id, timestamp, exact paths, and expected handoff evidence. When complete, change `Status` to `DONE`, add the commit SHA, and release the paths. A bot may then take a new claim after verifying the worktree and latest integration commit.

## Integration Requests

| Request | From | To | Status |
|---|---|---|---|
| Add public page-family route fixtures and accessibility coverage | `CODEX-01` | `MARKETING-PUBLIC-02`, `MARKETING-QA-02` | OPEN |
| Bridge legacy blog/landing edits into `marketing_pages` without double-publishing | `CODEX-01` | `CODEX-01` | CHECKPOINT READY |
| Add provider observation dashboards with explicit unavailable/partial states | `CODEX-01` | `MARKETING-DATA-02` | OPEN |
| Add duplicate-image and license contract tests | `CODEX-01` | `MARKETING-ASSETS-02`, `MARKETING-QA-02` | OPEN |
| Validate migration `0231` on PG16/Supabase and apply to production | `CODEX-01` | Supabase operator | EXTERNAL / OPEN |

### CODEX-01 checkpoint

```text
Lane: Platform spine + integration
Owner: CODEX-01
Files: migration 0231, platform worker/provider adapters, cron routes, public renderer/routes, sitemap/SEO bridge, asset provenance, coordination docs
Commit: `4e221d2b` on codex/reasoning-main-publication
Tests: npm test -- --reporter=dot -> 632 files / 3,744 tests passed
Typecheck: npm run typecheck -> pass
Migration: npm run db:audit:migrations -> pass; next available 0232; live REST check currently returns 404 for `marketing_pages` until 0231 is applied
Build: npm run build -> pass; 490 routes generated
Assets: npm run marketing:audit:assets -> pass; 18 unique shipped raster assets, no remote image URLs
Known follow-ups: follow `docs/MARKETING_PLATFORM_PRODUCTION_RUNBOOK.md`; run `npm run marketing:verify:remote` after applying migration 0231; configure real provider/API secrets; complete the other Claude lane handoffs
```

## Checkpoint Contract

At each handoff, report:

```text
Lane: <lane name>
Owner: <agent id>
Files: <exact paths>
Commit: <sha or uncommitted>
Tests: <focused command and result>
Typecheck: <pass/fail>
Migration: <number/status, if applicable>
Known follow-ups: <short list>
```

## Completion Criteria

The platform is not complete until every ownership lane has released its files, every named public page family is backed by Supabase, edits enqueue durable work, provider metrics are real or visibly unavailable, embeddings are provider-backed or visibly pending, asset provenance and deduplication are enforced, and the full local plus production verification gates pass.
