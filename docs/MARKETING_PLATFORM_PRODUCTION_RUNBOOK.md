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
   npm.cmd run db:push
   ```

   Migration `0231_marketing_platform_spine.sql` must be included. Do not run
   an isolated marketing migration against a production database whose earlier
   migration history has not been reconciled.

## Verify

Run the local gates against the release commit:

```powershell
npm.cmd run typecheck
npm.cmd test -- --reporter=dot
npm.cmd run marketing:audit:assets
npm.cmd run marketing:verify:remote
```

`marketing:verify:remote` must report these as available: the nine platform
tables (`marketing_pages`, versions, templates, brand rules, generation jobs,
relationships, embeddings, provider observations, and provider syncs) plus
the provenance columns on `marketing_assets` and `marketing_videos`.

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
  has license/source/attribution provenance.
- Inspect the first worker and provider-sync runs in logs; verify unavailable
  providers are recorded as unavailable rather than represented by invented
  metrics.

## Rollback

Stop the marketing cron schedules and revert the application deployment first.
Do not drop the platform tables or delete editorial data as an ad hoc rollback;
use the approved Supabase backup/restore procedure and record the incident.
