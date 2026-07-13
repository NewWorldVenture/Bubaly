import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = resolve(process.cwd(), 'scripts');

describe('seed credential safety', () => {
  it('loads Supabase access only from the environment', () => {
    const scripts = readdirSync(scriptsDir)
      .filter((name) => /^seed.*\.mjs$/i.test(name) && name !== 'seed-client.mjs')
      .map((name) => ({ name, source: readFileSync(resolve(scriptsDir, name), 'utf8') }));

    expect(scripts.length).toBeGreaterThan(0);
    for (const { name, source } of scripts) {
      expect(source, name).toContain('createSeedClient()');
      expect(source, name).not.toMatch(/createClient\s*\(/);
      expect(source, name).not.toMatch(/https?:\/\/[^\s'"`]+\.supabase\.co/);
      expect(source, name).not.toMatch(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/);
    }
  });
});
