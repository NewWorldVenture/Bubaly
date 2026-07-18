import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// PLA-0833: the SEO Page Registry (/admin/marketing/seo → marketing_seo_pages)
// drives <title>/meta ONLY for rows whose `path` matches a real route (looked up
// by exact path in lib/marketing/seo.ts `getSeoPage`). An external "Debug data
// seeding" tool inserted ~100+ rows with label paths like 'Seed data 1' that
// match no route and drive nothing — inert junk. Migration 0233 removes them.
const migration = readFileSync('supabase/migrations/0233_cleanup_seo_registry_seed_junk.sql', 'utf8');

describe('SEO registry junk cleanup (migration 0233)', () => {
  it('deletes the debug-seed + non-route junk from marketing_seo_pages', () => {
    expect(migration).toContain('DELETE FROM public.marketing_seo_pages');
    expect(migration).toContain("path LIKE 'Seed data%'");
    expect(migration).toContain("path NOT LIKE '/%'"); // any non-route path is inert
  });

  it('does not touch real route rows (only a DELETE with the junk predicate)', () => {
    // No UPDATE/DROP/TRUNCATE — a narrowly-scoped, idempotent DELETE only.
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|ALTER)\b/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.marketing_seo_pages/i);
  });

  it('has no repo source that reintroduces label-path SEO rows', () => {
    // Guard: no app/lib code writes a literal "Seed data" path into the registry
    // (the app's saveSeoPage normalises every path to a leading "/").
    const roots = ['app', 'lib', 'components'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const src = readFileSync(p, 'utf8');
        if (src.includes("'Seed data") || src.includes('"Seed data') || src.includes('`Seed data')) offenders.push(p);
      }
    };
    roots.forEach(walk);
    expect(offenders, `source writes "Seed data" rows:\n${offenders.join('\n')}`).toEqual([]);
  });
});
