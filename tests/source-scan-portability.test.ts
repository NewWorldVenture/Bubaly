import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles as jsxFiles, unnamedIconButtons } from './helpers/jsx-a11y-scan';
import { hoverReveals, sourceFiles as filesystemFiles } from './helpers/hover-reveals';
import { sourceFiles as styledFiles } from '../scripts/audit-unstyled-classes.mjs';

const logical = (value: string) => value.replaceAll('\\', '/');
const GIT_TARGET_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;

/** A real, owned repository; ambient read-only audit bindings must not target it. */
function repository<T>(run: (root: string, put: (name: string, text?: string, tracked?: boolean) => void) => T): T {
  const temporaryParent = resolve(tmpdir());
  const root = mkdtempSync(join(temporaryParent, "bubaly scanner's space-"));
  const saved = GIT_TARGET_VARIABLES.map((key) => [key, process.env[key]] as const);
  for (const key of GIT_TARGET_VARIABLES) delete process.env[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    const put = (name: string, text = 'export const synthetic = true;', tracked = true) => {
      const target = join(root, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      if (tracked) git('-c', 'core.autocrlf=false', 'add', '--', name);
    };
    return run(root, put);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const target = resolve(root);
    if (dirname(target) !== temporaryParent || !target.startsWith(join(temporaryParent, "bubaly scanner's space-"))) {
      throw new Error('Refusing cleanup outside the owned scanner fixture');
    }
    rmSync(target, { recursive: true, force: true });
  }
}

describe('source scanners retain their coverage across native paths', () => {
  it('finds the real tracked app rather than passing against an empty inventory', () => {
    const files = jsxFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('components/auth/join-invite.tsx');
    expect(files.some((file) => file.startsWith('app/') && file.endsWith('/page.tsx'))).toBe(true);
    expect(files.every((file) => !file.includes('\\') && !file.includes('\0'))).toBe(true);
  });

  it('returns exact tracked JSX filenames with spaces, apostrophes and non-ASCII text', () => repository((root, put) => {
    const wanted = ["app/family's space/page.tsx", 'components/café/clock control.tsx'];
    for (const name of wanted) put(name, 'export default () => <button><Clock /></button>;');
    put('components/fixture.test.tsx');
    put('app/plain/file.ts');
    put('lib/nested/widget.tsx');
    put('components/untracked.tsx', '<button />', false);
    const files = jsxFiles(root);
    expect(files.sort()).toEqual([...wanted].sort());
    // Consume the inventory as an actual JSX scanner, including the logical diagnostic label.
    for (const file of files) {
      const findings = unnamedIconButtons(file, readFileSync(join(root, file), 'utf8'));
      expect(findings).toEqual([{ file, line: 1, what: '<Clock />' }]);
    }
  }));

  it('consumes native NUL Git records without quoted or fragmented Unicode names', () => repository((root, put) => {
    const name = "app/café family's space/page.tsx";
    put(name);
    const native = execFileSync('git', ['-c', 'core.quotePath=true', 'ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    expect(native).toBe(`${name}\0`);
    expect(jsxFiles(root)).toEqual([name]);
  }));

  it('preserves the stylesheet scanner’s broader tracked extensions and roots', () => repository((root, put) => {
    const wanted = ['app/nested/route.ts', 'app/nested/page.tsx', 'components/nested/helper.ts', 'components/nested/button.tsx', 'lib/nested/view.tsx'];
    for (const name of wanted) put(name);
    put('lib/nested/service.ts');
    put('held/nested/view.tsx');
    put('components/untracked.tsx', '<button />', false);
    expect(styledFiles(root).sort()).toEqual([...wanted].sort());
  }));

  it('keeps untracked filesystem JSX in scope and emits usable POSIX diagnostic labels', () => repository((root, put) => {
    const name = "components/family's space/untracked control.tsx";
    put(name, '<button className="opacity-0 group-hover:opacity-100">Remove</button>', false);
    put('components/local.test.tsx', '<span>Still filesystem scope</span>', false);
    put('components/node_modules/ignored.tsx', '<button />', false);
    put('components/.next/ignored.tsx', '<button />', false);
    put('components/plain.ts', 'export const ignored = true;', false);
    const files = filesystemFiles(join(root, 'components'));
    expect(files.sort()).toEqual([logical(join(root, name)), logical(join(root, 'components/local.test.tsx'))].sort());
    expect(hoverReveals(files)).toEqual([{ at: `${logical(join(root, name))}:1`, tag: 'button', focusable: true, classes: ['opacity-0', 'group-hover:opacity-100'] }]);
  }));

  it('fails a missing repository target rather than silently producing an empty audit', () => repository((root) => {
    expect(() => jsxFiles(join(root, 'missing repository'))).toThrow();
    expect(() => styledFiles(join(root, 'missing repository'))).toThrow();
  }));

  it('runs the stylesheet CLI and rejects a class that emits no styles', () => {
    const script = resolve('scripts/audit-unstyled-classes.mjs');
    repository((root, put) => {
      put('app/nested/page.tsx', 'export default () => <div className="bg-red-500 bubaly-gone-class" />;');
      put('app/globals.css', '@tailwind utilities;');
      put('tailwind.config.ts', 'export default { content: [], theme: { extend: {} }, plugins: [] };');
      const result = spawnSync(process.execPath, [script], {
        cwd: root, env: process.env, encoding: 'utf8', timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, JSON.stringify({ stdout: result.stdout, stderr: result.stderr })).toBe(1);
      expect(result.stdout).toContain('1 files');
      expect(result.stdout).toContain('1 class name(s) style nothing:');
      expect(result.stdout).toContain('bubaly-gone-class');
      expect(result.stdout).toContain('app/nested/page.tsx:1');
    });
  });
});
