import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = resolve(process.cwd(), 'scripts');

describe('seed tooling TLS safety', () => {
  it('does not disable certificate verification in seed scripts', () => {
    const unsafe = readdirSync(scriptsDir)
      .filter((name) => /^seed.*\.mjs$/i.test(name))
      .filter((name) => /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['\"]0['\"]/.test(
        readFileSync(resolve(scriptsDir, name), 'utf8'),
      ));

    expect(unsafe).toEqual([]);
  });
});
