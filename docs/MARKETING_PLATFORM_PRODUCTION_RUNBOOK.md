# Marketing Platform Production Runbook

This runbook is the release gate for the Supabase-backed marketing platform.
The application code can build before the platform schema exists, but the
marketing control center and canonical public page registry are not considered
production-ready until the remote checks below pass.

## Apply

1. Confirm the target Supabase project and take a backup with a tested restore
   path.
2. From the repository root, link the Supabase CLI to the target project:

   ```powershell
   supabase link --project-ref <production-project-ref>
   ```

3. Reconcile the migration ledger, then apply the ordered migrations:

   ```powershell
   npm.cmd run db:audit:migrations
   supabase migration list --linked
   npm.cmd run db:push
   ```

   Migration `0231_marketing_platform_spine.sql` must be included. Do not run
   an isolated marketing migration against a production database whose earlier
   migration history has not been reconciled. The production workflow performs
   the same ledger preflight and fails closed before `db push` when the remote
   history cannot be read. If a migration was applied manually, use the
   reviewed `supabase migration repair --status applied <version>` command only
   after confirming that migration's schema changes are already present.

4. Audit existing Supabase media. If the dry run reports legacy rows without
   hashes, resolve any duplicate groups first, then run the explicit write:

   ```powershell
   npm.cmd run marketing:backfill:provenance
   npm.cmd run marketing:backfill:provenance -- --apply
   ```

For repeatable production releases, configure the GitHub `production`
environment with `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
`SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`. The `Supabase production
migrations` workflow then applies the ordered ledger on `main` migration
changes, runs the provenance backfill, and blocks completion until the schema,
public/private access-boundary, and media provenance gates pass.

## Verify

Run the local gates against the release commit:

```powershell
npm.cmd run typecheck
npm.cmd test -- --reporter=dot
npm.cmd run marketing:audit:assets
npm.cmd run marketing:verify:remote
npm.cmd run marketing:verify:public:remote
npm.cmd run marketing:verify:assets:remote
```

`marketing:verify:remote` must report these as available: the nine platform
tables (`marketing_pages`, versions, templates, brand rules, generation jobs,
relationships, embeddings, provider observations, and provider syncs) plus
the provenance columns on `marketing_assets` and `marketing_videos`.
`marketing:verify:public:remote` additionally proves anonymous clients can read
published pages only, cannot read drafts or deleted pages, and cannot read the
admin-only marketing tables.

## Configure

Set the server-only provider credentials in the deployment environment before
enabling automated provider syncs: `CRON_SECRET`, OpenAI or Anthropic model
credentials, Google Search Console credentials, Bing Webmaster credentials,
and the optional AI-citation provider endpoint/key. Missing providers must
remain visibly unavailable; never seed synthetic rankings, citations, or
embeddings.

## Operational checks

- Confirm `/admin/marketing/platform` loads for a Super Admin and rejects a
  non-admin session.
- Create, edit, publish, and archive one test page; confirm each edit creates
  a version and a queued regeneration job, and that the worker can claim it.
- Confirm the public route is published-only and that archive removes it from
  sitemap output and public reads.
- Confirm duplicate active media hashes are rejected and every uploaded asset
  has license/source/attribution provenance. Uploaded video rows must reuse the
  selected Asset Library byte hash so cross-library duplicate media is rejected;
  external videos must retain a source URL and attribution when their license
  requires it.
- Inspect the first worker and provider-sync runs in logs; verify unavailable
  providers are recorded as unavailable rather than represented by invented
  metrics.

## Rollback

Stop the marketing cron schedules and revert the application deployment first.
Do not drop the platform tables or delete editorial data as an ad hoc rollback;
use the approved Supabase backup/restore procedure and record the incident.
