import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0231_marketing_platform_spine.sql', 'utf8');
const platform = readFileSync('lib/marketing/platform.ts', 'utf8');
const worker = readFileSync('app/api/cron/marketing/route.ts', 'utf8');
const providers = readFileSync('app/api/cron/marketing-providers/route.ts', 'utf8');
const providerSync = readFileSync('lib/marketing/provider-sync.ts', 'utf8');
const featureRoute = readFileSync('app/(marketing)/features/[slug]/page.tsx', 'utf8');
const customRoute = readFileSync('app/(marketing)/p/[slug]/page.tsx', 'utf8');
const verifier = readFileSync('scripts/verify-marketing-platform.mjs', 'utf8');
const remoteAssetVerifier = readFileSync('scripts/verify-marketing-assets-remote.mjs', 'utf8');
const provenanceBackfill = readFileSync('scripts/backfill-marketing-asset-provenance.mjs', 'utf8');
const migrationSource = readFileSync('supabase/migrations/0231_marketing_platform_spine.sql', 'utf8');
const legacyBridge = readFileSync('lib/marketing/legacy-bridge.ts', 'utf8');
const contentActions = readFileSync('app/(app)/admin/marketing/content/actions.ts', 'utf8');
const landingActions = readFileSync('app/(app)/admin/marketing/actions.ts', 'utf8');
const landingRoute = readFileSync('app/(marketing)/lp/[slug]/page.tsx', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('marketing platform spine contract', () => {
  it('defines the durable page, version, queue, vector, and provider tables', () => {
    for (const table of [
      'marketing_pages', 'marketing_page_versions', 'marketing_content_templates',
      'marketing_brand_rules', 'marketing_generation_jobs', 'marketing_page_relationships',
      'marketing_embeddings', 'marketing_provider_observations', 'marketing_provider_syncs',
    ]) {
      expect(migration).toContain(`create table if not exists public.${table}`);
    }
    expect(migration).toContain('create extension if not exists vector with schema extensions');
    expect(migration).toContain('unique(page_id, version)');
    expect(migration).toContain('idempotency_key text not null unique');
    expect(migration).toContain('page_path text not null default \'\'');
    expect(migration).toContain('query text not null default \'\'');
  });

  it('keeps public reads published-only and grants the queue to service_role', () => {
    expect(migration).toContain('using (status = \'published\' and deleted_at is null)');
    expect(migration).toContain('grant select on public.marketing_pages, public.marketing_page_relationships to anon, authenticated');
    expect(migration).toContain('grant execute on function public.claim_marketing_generation_jobs(integer) to service_role');
    expect(migration).toContain('has_table_privilege(\'anon\', \'public.marketing_pages\', \'SELECT\')');
    expect(migration).toContain('create policy marketing_page_versions_admin_read on public.marketing_page_versions for select');
    expect(migration).toContain('grant select on public.marketing_page_versions to authenticated');
    expect(migration).toContain('revoke insert, update, delete on public.marketing_page_versions from authenticated');
  });

  it('enqueues automatic regeneration and chains AEO plus embedding work', () => {
    expect(migration).toContain('trg_enqueue_marketing_page_generation_insert');
    expect(migration).toContain('trg_enqueue_marketing_page_generation_update');
    expect(migration).toContain('new.path is distinct from old.path');
    expect(migration).toContain('new.parent_id is distinct from old.parent_id');
    expect(platform).toContain("jobType: 'generate_questions'");
    expect(platform).toContain("jobType: 'embed_page'");
    expect(platform).toContain('text-embedding-3-small');
    expect(platform).toContain('getAIConfig(supabase)');
  });

  it('protects both cron surfaces with the shared authorization guard', () => {
    expect(worker).toContain('hasCronAuthorization(req)');
    expect(providers).toContain('hasCronAuthorization(req)');
    expect(worker).toContain('processMarketingGenerationJobs');
    expect(providers).toContain('syncMarketingProviders');
    expect(providerSync).toContain("page_path: ''");
    expect(providerSync).toContain("query: ''");
    expect(providerSync).toContain("onConflict: 'provider,engine,observed_for,page_path,query'");
  });

  it('exposes every platform page type through a public route family', () => {
    for (const route of [
      'questions/[slug]', 'guides/[slug]', 'compare/[slug]', 'alternatives/[slug]',
      'audiences/[slug]', 'resources/[slug]', 'glossary/[slug]',
    ]) {
      expect(readFileSync(`app/(marketing)/${route}/page.tsx`, 'utf8')).toContain('MarketingPageView');
    }
    expect(featureRoute).toContain("marketingPageMetadata('feature'");
    expect(customRoute).toContain("marketingPageMetadata('custom'");
  });

  it('ships a remote schema gate for the production Supabase project', () => {
    expect(verifier).toContain('marketing_pages');
    expect(verifier).toContain('marketing_embeddings');
    expect(verifier).toContain('marketing_assets?select=content_hash,license,source_url,attribution');
    expect(verifier).toContain('process.exit(1)');
    expect(ciWorkflow).toContain('npm run marketing:verify:remote');
    expect(ciWorkflow).toContain('npm run marketing:verify:assets:remote');
  });

  it('ships strict remote asset provenance and a safe legacy backfill', () => {
    expect(remoteAssetVerifier).toContain('content_hash');
    expect(remoteAssetVerifier).toContain('source_hash');
    expect(remoteAssetVerifier).toContain('duplicate asset hash');
    expect(remoteAssetVerifier).toContain('source_url and attribution');
    expect(provenanceBackfill).toContain("process.argv.includes('--apply')");
    expect(provenanceBackfill).toContain('Dry run only');
    expect(provenanceBackfill).toContain("from('marketing-assets')");
  });

  it('does not enqueue regeneration for archived canonical pages', () => {
    expect(migrationSource).toContain('new.deleted_at is null and new.version is distinct from old.version');
    expect(migrationSource).toContain("locked_at < now() - interval '15 minutes'");
    expect(migrationSource).toContain('engine text not null default \'unknown\'');
    expect(migrationSource).toContain('drop policy if exists marketing_pages_admin_all');
    expect(migrationSource).toContain('uq_mkt_default_template_per_type');
  });

  it('provides a missing-schema-safe legacy blog bridge', () => {
    expect(legacyBridge).toContain("page_type: 'blog'");
    expect(legacyBridge).toContain("onConflict: 'path'");
    expect(legacyBridge).toContain('migration 0231 is not applied');
    expect(legacyBridge).toContain('archiveLegacyBlogOnPlatform');
    expect(contentActions).toContain('syncLegacyBlogToPlatform');
    expect(contentActions).toContain('syncLegacyBlogVisibility');
    expect(landingActions).toContain('syncLegacyLandingToPlatform');
    expect(landingActions).toContain('archiveLegacyLandingOnPlatform');
    expect(landingRoute).toContain("MarketingPageView type=\"landing\"");
  });
});
