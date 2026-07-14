import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const assets = readFileSync('app/(app)/admin/marketing/assets/actions.ts', 'utf8');
const content = readFileSync('app/(app)/admin/marketing/content/actions.ts', 'utf8');

describe('marketing asset and content action boundaries', () => {
  it('uses sanitized failures and checks every asset mutation result', () => {
    expect(assets).toContain('marketingActionFailure');
    expect(assets).toContain('rollback failed');
    expect(assets).toContain(".select('id').maybeSingle()");
    expect(assets).toContain(".select('id, storage_path')");
    expect(assets).not.toMatch(/await supabase\.from\('marketing_assets'\).*\.eq\('id', id\);/s);
  });

  it('fails closed across content reads, blog publishing, and unpublishing', () => {
    expect(content).toContain('marketingActionFailure');
    expect(content).toContain('load the marketing content item');
    expect(content).toContain('publish the blog post');
    expect(content).toContain('mark the content item as published');
    expect(content).toContain('unpublish the blog post');
    expect(content).toContain(".select('slug').single()");
    expect(content).toContain(".select('id').maybeSingle()");
  });
});
