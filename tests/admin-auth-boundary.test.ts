import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function actionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? actionFiles(path) : entry.name.endsWith('actions.ts') ? [path] : [];
  });
}

const adminRoot = 'app/(app)/admin';
const actions = actionFiles(adminRoot);

describe('admin authentication boundary', () => {
  it('keeps every service-role admin action behind an explicit privileged guard', () => {
    expect(actions.length).toBeGreaterThan(10);
    for (const path of actions) {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('createServiceClient')) continue;
      expect(source, path).toMatch(/isSuperAdmin|requireMarketingAdmin|assertSuperAdmin|guard\(/);
    }
  });

  it('keeps the admin page boundary and middleware session gate explicit', () => {
    const layout = readFileSync(join(adminRoot, 'layout.tsx'), 'utf8');
    const middleware = readFileSync('middleware.ts', 'utf8');
    expect(layout).toContain('const superAdmin = await isSuperAdmin()');
    expect(layout).toContain("if (!superAdmin) redirect('/dashboard')");
    expect(middleware).toContain('supabase.auth.getUser()');
    expect(middleware).toContain("url.pathname = '/login'");
  });
});
