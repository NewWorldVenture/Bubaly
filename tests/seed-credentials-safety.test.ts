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
      expect(source, name).toContain('requireSeedScope()');
      expect(source, name).not.toMatch(/createClient\s*\(/);
      expect(source, name).not.toMatch(/https?:\/\/[^\s'"`]+\.supabase\.co/);
      expect(source, name).not.toMatch(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/);
      expect(source, name).not.toMatch(/a0cba6bd-88f7-48a9-926d-b27e5cf671dc/);
      expect(source, name).not.toMatch(/df41e924-9bea-4980-98d4-f9d78df05e49/);
    }
  });
});
