import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0237_marketing_platform_spine.sql', 'utf8');
const imageMigration = readFileSync('supabase/migrations/0238_blog_image_provenance.sql', 'utf8');
const platform = readFileSync('lib/marketing/platform.ts', 'utf8');
const worker = readFileSync('app/api/cron/marketing/route.ts', 'utf8');
const providers = readFileSync('app/api/cron/marketing-providers/route.ts', 'utf8');
const providerSync = readFileSync('lib/marketing/provider-sync.ts', 'utf8');
const featureRoute = readFileSync('app/(marketing)/features/[slug]/page.tsx', 'utf8');
const customRoute = readFileSync('app/(marketing)/p/[slug]/page.tsx', 'utf8');
const verifier = readFileSync('scripts/verify-marketing-platform.mjs', 'utf8');
const remoteAssetVerifier = readFileSync('scripts/verify-marketing-assets-remote.mjs', 'utf8');
const videoActions = readFileSync('app/(app)/admin/marketing/video/actions.ts', 'utf8');
const provenanceBackfill = readFileSync('scripts/backfill-marketing-asset-provenance.mjs', 'utf8');
const migrationSource = readFileSync('supabase/migrations/0237_marketing_platform_spine.sql', 'utf8');
const legacyBridge = readFileSync('lib/marketing/legacy-bridge.ts', 'utf8');
const contentActions = readFileSync('app/(app)/admin/marketing/content/actions.ts', 'utf8');
const landingActions = readFileSync('app/(app)/admin/marketing/actions.ts', 'utf8');
const landingRoute = readFileSync('app/(marketing)/lp/[slug]/page.tsx', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const productionMigrationWorkflow = readFileSync('.github/workflows/supabase-production-migrations.yml', 'utf8');
const imageBackfill = readFileSync('scripts/backfill-marketing-image-provenance.mjs', 'utf8');
const blogGenerator = readFileSync('scripts/generate-blog-posts.mjs', 'utf8');
const coverageBackfill = readFileSync('scripts/backfill-marketing-coverage.mjs', 'utf8');
const coverageVerifier = readFileSync('scripts/verify-marketing-coverage-remote.mjs', 'utf8');
const platformAdmin = readFileSync('app/(app)/admin/marketing/platform/page.tsx', 'utf8');
const runtimeVerifier = readFileSync('scripts/verify-marketing-runtime-remote.mjs', 'utf8');

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
    expect(migration).toContain('using hnsw (embedding extensions.vector_cosine_ops)');
    expect(migration).toContain('page_path text not null default \'\'');
    expect(migration).toContain('query text not null default \'\'');
    expect(migration).toContain('alter table public.marketing_videos add column if not exists source_url text');
    expect(migration).toContain('alter table public.marketing_videos add column if not exists attribution text');
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
    expect(platform).toContain('chunkMarketingText');
    expect(platform).toContain('for (let offset = 0; offset < missing.length; offset += 32)');
    expect(platform).toContain("status: 'stale'");
    expect(platform).toContain('getAIConfig(supabase)');
    expect(platform).toContain(".eq('status', 'running').select('id').maybeSingle()");
    expect(platform).toContain('Could not persist success for marketing job');
    expect(platform).toContain('Could not persist failure for marketing job');
    expect(platform).toContain('persistenceFailed');
    expect(platform).toContain('const { error: versionError }');
    expect(platform).toContain('const { error: deleteError }');
  });

  it('protects both cron surfaces with the shared authorization guard', () => {
    expect(worker).toContain('hasCronAuthorization(req)');
    expect(providers).toContain('hasCronAuthorization(req)');
    expect(worker).toContain('processMarketingGenerationJobs');
    expect(providers).toContain('syncMarketingProviders');
    expect(providerSync).toContain("page_path: ''");
    expect(providerSync).toContain("query: ''");
    expect(providerSync).toContain("onConflict: 'provider,engine,observed_for,page_path,query'");
    expect(providerSync).toContain("ready: Object.values(results).every((result) => result.ok && result.configured)");
    expect(providers).toContain('ready: summary.ready');
  });

  it('executes queued provider refreshes and revalidates sitemap jobs', () => {
    expect(platform).toContain("import { revalidatePath } from 'next/cache';");
    expect(platform).toContain("import { syncMarketingProviders } from './provider-sync';");
    expect(platform).toContain("revalidatePath('/sitemap.xml')");
    expect(platform).toContain('await syncMarketingProviders(supabase)');
    expect(platform).not.toContain("reason: 'Provider adapter pending configuration.'");
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

  it('ships a guarded production migration workflow with post-apply gates', () => {
    expect(productionMigrationWorkflow).toContain('supabase db push --yes');
    expect(productionMigrationWorkflow).toContain('marketing:backfill:provenance -- --apply');
    expect(productionMigrationWorkflow).toContain('marketing:verify:remote');
    expect(productionMigrationWorkflow).toContain('marketing:verify:assets:remote');
    expect(productionMigrationWorkflow).toContain('environment: production');
    expect(productionMigrationWorkflow).toContain('SUPABASE_ACCESS_TOKEN');
    expect(productionMigrationWorkflow).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('ships strict remote asset provenance and a safe legacy backfill', () => {
    expect(remoteAssetVerifier).toContain('content_hash');
    expect(remoteAssetVerifier).toContain('source_hash');
    expect(remoteAssetVerifier).toContain('duplicate asset hash');
    expect(remoteAssetVerifier).toContain('source_url and attribution');
    expect(remoteAssetVerifier).toContain('video.source_url || video.url');
    expect(videoActions).toContain("select('storage_path, content_hash, license, source_url, attribution')");
    expect(videoActions).toContain('source_hash = asset.content_hash');
    expect(videoActions).toContain('source_url,');
    expect(provenanceBackfill).toContain("process.argv.includes('--apply')");
    expect(provenanceBackfill).toContain('Dry run only');
    expect(provenanceBackfill).toContain("from('marketing-assets')");
    expect(provenanceBackfill).toContain('assetByStoragePath');
    expect(provenanceBackfill).toContain('asset?.content_hash ?? hashVideoSource(video)');
  });

  it('covers public blog hero images with fail-closed provenance and deduplication', () => {
    expect(imageMigration).toContain('hero_image_source_url text');
    expect(imageMigration).toContain('hero_image_license text');
    expect(imageMigration).toContain('hero_image_attribution text');
    expect(imageMigration).toContain('hero_image_source_hash text');
    expect(imageMigration).toContain('CREATE TRIGGER trg_blog_image_provenance');
    expect(imageMigration).toContain('approved free-use license');
    expect(imageMigration).toContain('uq_blog_posts_hero_image_source_url');
    expect(imageMigration).toContain('uq_blog_posts_hero_image_source_hash');
    expect(imageBackfill).toContain('Duplicate blog hero image source');
    expect(imageBackfill).toContain("process.argv.includes('--apply')");
    expect(remoteAssetVerifier).toContain('blog_posts?select=id,slug,published');
    expect(remoteAssetVerifier).toContain('approvedBlogLicenses');
    expect(productionMigrationWorkflow).toContain('marketing:backfill:image-provenance -- --apply');
    expect(blogGenerator).toContain('https://picsum.photos/seed/');
    expect(blogGenerator).toContain('Lorem Picsum (CC0)');
  });

  it('reconciles canonical SEO/AEO coverage and verifies citable public pages', () => {
    expect(coverageBackfill).toContain('buildSeo(page)');
    expect(coverageBackfill).toContain('buildQuestions(page)');
    expect(coverageBackfill).toContain("metadata: { source: 'marketing_platform', page_id: page.id }");
    expect(coverageBackfill).toContain('placeholderAeoIds');
    expect(coverageBackfill).toContain('updated_by: null');
    expect(coverageBackfill).toContain('Dry run only');
    expect(coverageVerifier).toContain('canonical SEO');
    expect(coverageVerifier).toContain('canonical AEO');
    expect(coverageVerifier).toContain('no registered public AEO row');
    expect(productionMigrationWorkflow).toContain('marketing:backfill:coverage -- --apply');
    expect(productionMigrationWorkflow).toContain('marketing:verify:coverage:remote');
  });

  it('reports runtime backlog and vector/provider readiness without fabricating health', () => {
    expect(runtimeVerifier).toContain('marketing_generation_jobs');
    expect(runtimeVerifier).toContain('marketing_embeddings');
    expect(runtimeVerifier).toContain('marketing_provider_syncs');
    expect(runtimeVerifier).toContain("const strict = process.argv.includes('--strict');");
    expect(runtimeVerifier).toContain('truthful warnings');
    expect(productionMigrationWorkflow).toContain('marketing:verify:runtime:remote');
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
    expect(legacyBridge).toContain('marketing platform migration is not applied');
    expect(legacyBridge).toContain('archiveLegacyBlogOnPlatform');
    expect(contentActions).toContain('syncLegacyBlogToPlatform');
    expect(contentActions).toContain('syncLegacyBlogVisibility');
    expect(landingActions).toContain('syncLegacyLandingToPlatform');
    expect(landingActions).toContain('archiveLegacyLandingOnPlatform');
    expect(landingRoute).toContain("MarketingPageView type=\"landing\"");
  });

  it('makes the admin operations view truthful about queue and provider health', () => {
    expect(platformAdmin).toContain("select('id', { count: 'exact', head: true })");
    expect(platformAdmin).toContain("eq('status', 'running').lt('locked_at', staleWorkerCutoff)");
    expect(platformAdmin).toContain("select('job_type, target_path, completed_at')");
    expect(platformAdmin).toContain("marketing_provider_observations");
    expect(platformAdmin).toContain("marketing_embeddings");
    expect(platformAdmin).toContain("const embeddingStatuses = ['ready', 'queued', 'failed', 'stale']");
    expect(platformAdmin).toContain('Vector index health');
    expect(platformAdmin).toContain('No ready vectors are currently persisted');
    expect(platformAdmin).toContain('Provider status is live from Supabase');
    expect(platformAdmin).toContain('Unconfigured sources never appear as measured traffic');
    expect(platformAdmin).toContain('Last successful job:');
  });
});
