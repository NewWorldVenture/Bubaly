import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesMatching, NON_ACTION_FILES, perFile, unconfirmedWritesIn, USE_SERVER_FILES } from './helpers/unconfirmed-writes';

const unsafe = "await db.from('t').update({ a: 1 }).eq('id', id);\n";
const writePattern = /\.(update|delete)\(/;

function withSources(run: (cwd: string) => void) {
  const temporaryRoot = path.resolve(tmpdir());
  const cwd = mkdtempSync(path.join(temporaryRoot, 'unconfirmed scanner-é-'));
  const sources: Record<string, string> = {
    'app/route.ts': unsafe,
    'app/.hidden/deep.ts': unsafe,
    'lib/node_modules/cache.ts': unsafe,
    'lib/space 資料/worker.tsx': "await db.from('t').delete().eq('id', id);\n",
    'app/actions.ts': "'use server';\n" + unsafe,
    'app/action.test.ts': "'use server';\n" + unsafe,
    'lib/banner.ts': "// header\n'use server';\n" + unsafe,
    'app/indented.ts': " 'use server';\n" + unsafe,
    'lib/double.ts': '"use server";\n' + unsafe,
    'app/model.test.ts': unsafe,
    'lib/model.d.ts': unsafe,
    'lib/model.spec.ts': unsafe,
    'lib/confirmed.ts': "await db.from('t').update({ a: 1 }).eq('id', id).select('id');\n",
    'lib/comment-only.ts': '// .update(\n',
    'app/plain-read.ts': "await db.from('t').select('id');\n",
    'app/outside.js': unsafe,
    'lib/outside.ts.bak': unsafe,
    'components/panel.tsx': unsafe,
    'outside/escaped.ts': unsafe,
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      const target = path.join(cwd, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    run(cwd);
  } finally {
    expect(path.dirname(path.resolve(cwd))).toBe(temporaryRoot);
    expect(path.basename(cwd)).toMatch(/^unconfirmed scanner-é-/);
    rmSync(cwd, { recursive: true, force: true });
  }
}

const nonActions = [
  'app/.hidden/deep.ts', 'app/indented.ts', 'app/route.ts',
  'lib/comment-only.ts', 'lib/confirmed.ts', 'lib/double.ts', 'lib/model.spec.ts',
  'lib/node_modules/cache.ts', 'lib/space 資料/worker.tsx',
].sort();

function scan(cwd: string) {
  return Object.fromEntries(perFile(NON_ACTION_FILES(cwd).flatMap(file =>
    unconfirmedWritesIn(path.join(cwd, file)).map(site => ({ ...site, file })))));
}

describe('unconfirmed-write enumeration preserves the recursive source scope', () => {
  it('includes untracked, hidden and nested sources with normalized sorted paths', () => {
    withSources(cwd => {
      expect(existsSync(path.join(cwd, '.git'))).toBe(false);
      expect(NON_ACTION_FILES(cwd)).toEqual(nonActions);
      expect(filesMatching(['components'], writePattern, cwd)).toEqual(['components/panel.tsx']);
    });
  });

  it('keeps the exact single-quoted line-start action classification and test/declaration exclusions', () => {
    withSources(cwd => {
      expect(USE_SERVER_FILES(cwd)).toEqual(['app/action.test.ts', 'app/actions.ts', 'lib/banner.ts']);
      expect(NON_ACTION_FILES(cwd)).toContain('app/indented.ts');
      expect(NON_ACTION_FILES(cwd)).toContain('lib/double.ts');
      expect(NON_ACTION_FILES(cwd)).toContain('lib/model.spec.ts');
      expect(NON_ACTION_FILES(cwd)).not.toContain('app/model.test.ts');
      expect(NON_ACTION_FILES(cwd)).not.toContain('lib/model.d.ts');
    });
  });

  it('passes actual unsafe writes to the unchanged detector without counting confirmed writes or comments', () => {
    withSources(cwd => {
      expect(scan(cwd)).toEqual(Object.fromEntries(nonActions
        .filter(file => file !== 'lib/comment-only.ts' && file !== 'lib/confirmed.ts')
        .map(file => [file, 1])));
    });
  });

  it('detects a newly added untracked source and a grown unsafe-write count', () => {
    withSources(cwd => {
      const baseline = scan(cwd);
      const extra = 'app/new untracked é.tsx';
      writeFileSync(path.join(cwd, extra), unsafe);
      writeFileSync(path.join(cwd, 'app/route.ts'), unsafe.repeat(2));
      const found = scan(cwd);
      expect(found).toEqual({ ...baseline, [extra]: 1, 'app/route.ts': 2 });
      expect(() => expect(found).toEqual(baseline)).toThrow();
    });
  });

  it('skips discovered directory links but traverses a link named as an explicit root', () => {
    withSources(cwd => {
      symlinkSync(path.join(cwd, 'outside'), path.join(cwd, 'app/linked'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(NON_ACTION_FILES(cwd)).toEqual(nonActions);
      expect(filesMatching(['app/linked'], writePattern, cwd)).toEqual(['app/linked/escaped.ts']);
    });
  });

  it('surfaces a missing source root instead of silently dropping its scope', () => {
    withSources(cwd => {
      expect(() => filesMatching(['missing'], writePattern, cwd)).toThrow();
    });
  });
});
