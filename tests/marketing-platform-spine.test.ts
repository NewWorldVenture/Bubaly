import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/0231_marketing_platform_spine.sql', 'utf8');
const platform = readFileSync('lib/marketing/platform.ts', 'utf8');
const worker = readFileSync('app/api/cron/marketing/route.ts', 'utf8');
const providers = readFileSync('app/api/cron/marketing-providers/route.ts', 'utf8');
const featureRoute = readFileSync('app/(marketing)/features/[slug]/page.tsx', 'utf8');
const customRoute = readFileSync('app/(marketing)/p/[slug]/page.tsx', 'utf8');

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
  });

  it('keeps public reads published-only and grants the queue to service_role', () => {
    expect(migration).toContain('using (status = \'published\' and deleted_at is null)');
    expect(migration).toContain('grant select on public.marketing_pages, public.marketing_page_relationships to anon, authenticated');
    expect(migration).toContain('grant execute on function public.claim_marketing_generation_jobs(integer) to service_role');
    expect(migration).toContain('has_table_privilege(\'anon\', \'public.marketing_pages\', \'SELECT\')');
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
});
