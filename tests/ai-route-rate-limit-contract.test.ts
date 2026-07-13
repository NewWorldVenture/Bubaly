import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const roots = [
  resolve(process.cwd(), 'app/api/ai'),
  resolve(process.cwd(), 'app/api/vacations/ai'),
  resolve(process.cwd(), 'app/api/recipes/suggest'),
  resolve(process.cwd(), 'app/api/recipes/transform'),
  resolve(process.cwd(), 'app/api/vacations/weather'),
  resolve(process.cwd(), 'app/api/weekend/discover'),
  resolve(process.cwd(), 'app/api/admin/marketing/ai'),
  resolve(process.cwd(), 'app/api/behavior/insight'),
  resolve(process.cwd(), 'app/api/gif/search'),
];

function routeFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

describe('model and external side-effect route limits', () => {
  it('requires a durable guard before provider or external fetch work', () => {
    for (const file of roots.flatMap(routeFiles)) {
      const source = readFileSync(file, 'utf8');
      const external = /resolveProvider|api\.openai\.com|fetch\(/.test(source);
      if (!external) continue;
      const name = relative(process.cwd(), file);
      expect(source, name).toMatch(/enforceAIRateLimit|enforceRequestRateLimit|rateLimitDb/);
      expect(source, name).toContain("'Retry-After'");
    }

    const marketing = readFileSync(resolve(process.cwd(), 'app/api/admin/marketing/ai/route.ts'), 'utf8');
    expect(marketing).toContain('4_000');
    expect(marketing).toContain('16_000');
  });
});
