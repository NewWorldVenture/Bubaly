import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { globSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
type Defaults = { run?: { 'working-directory'?: string } };
type Step = { run?: string; 'working-directory'?: string };
type Workflow = {
  on?: Record<string, { paths?: string[] } | null>;
  defaults?: Defaults;
  jobs?: Record<string, { defaults?: Defaults; steps?: Step[] }>;
};
type ScriptLoader = (directory: string) => Record<string, string>;
const { load } = createRequire(import.meta.url)('js-yaml') as { load(source: string): Workflow };
const readScripts: ScriptLoader = (directory) => (JSON.parse(
  readFileSync(join(ROOT, directory, 'package.json'), 'utf8'),
) as { scripts?: Record<string, string> }).scripts ?? {};

/**
 * A `paths:` filter decides when a push re-runs the workflow, so anything the
 * workflow DEPENDS ON has to be in it. A dependency that is missing does not
 * fail — the workflow simply does not run, which is the quietest possible way
 * for a gate to stop gating.
 *
 * `supabase-production-migrations.yml` is where that matters most: it is the
 * workflow that runs `supabase db push --yes` against production. Its filter
 * already names nine scripts, the workflow itself, package.json and
 * `supabase/migrations/**`, so the intent is unambiguous — list what this
 * depends on. Two had drifted out of it:
 *
 *   scripts/audit-supabase-queries.mjs        the gate whose own step comment
 *                                             says it catches "a query naming a
 *                                             column or table the release does
 *                                             not create ... fails only at
 *                                             runtime, as an empty page"
 *   scripts/verify-marketing-runtime-remote.mjs
 *
 * Push a fix to either of those alone and production was never re-verified with
 * the fixed gate — not until some other listed file happened to change.
 *
 * The rule is scoped to workflows that actually declare a `paths:` filter. A
 * workflow without one runs on every push and has nothing to drift.
 */

function workflowsWithPathFilters(): { file: string; source: string; paths: string[] }[] {
  const out: { file: string; source: string; paths: string[] }[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const source = readFileSync(join(WORKFLOWS, file), 'utf8');
    // Parse real event paths, not comments or unrelated YAML lists. Check each
    // event separately: a push path cannot make up for a missing PR path.
    for (const event of Object.values(load(source).on ?? {})) {
      if (event?.paths) out.push({ file, source, paths: event.paths });
    }
  }
  return out;
}

function repositoryPath(directory: string, file = '.'): string {
  const value = posix.normalize(posix.join(directory, file));
  if (value.startsWith('/') || value === '..' || value.startsWith('../') || /[$\\]/.test(value)) {
    throw new Error(`Expected a literal repository path, got ${value}`);
  }
  return value;
}

/**
 * Current workflows use literal Node script commands, npm run and npm ci.
 * Follow the effective GitHub working directory, nested npm scripts and npm
 * lifecycles. This is a command/dependency guard, not a general shell parser or
 * a transitive import analyser; support inputs such as patch JSON remain
 * explicit workflow paths.
 */
function scriptsRunBy(source: string, scriptsAt: ScriptLoader = readScripts): Set<string> {
  const workflow = load(source);
  const files = new Set<string>();
  const visiting = new Set<string>();

  function script(directory: string, name: string, required: boolean, hooks = true) {
    const scripts = scriptsAt(directory);
    if (!(name in scripts)) {
      if (required) throw new Error(`Missing npm script ${directory}:${name}`);
      return;
    }
    const key = `${directory}:${name}`;
    if (visiting.has(key)) throw new Error(`Cyclic npm script ${key}`);
    visiting.add(key);
    if (hooks) script(directory, `pre${name}`, false, false);
    commands(scripts[name], directory);
    if (hooks) script(directory, `post${name}`, false, false);
    visiting.delete(key);
  }

  function commands(source: string, directory: string) {
    // Only executable command starts count; YAML/shell comments must not
    // provide a false dependency. The supported commands are literal.
    for (const command of source.split(/\n|&&|\|\||;/).map((part) => part.trim())) {
      if (command.startsWith('#')) continue;
      const node = command.match(/^node\s+(?:(?:--test|--[\w-]+=[^\s]+)\s+)*((?:\.{1,2}\/)?(?:[\w.-]+\/)*scripts\/[\w.-]+\.mjs)(?:\s|$)/);
      if (node) files.add(repositoryPath(directory, node[1]));
      const npm = command.match(/^npm run ([a-z0-9:_-]+)(?:\s|$)/);
      if (npm) script(directory, npm[1], true);
      if (/^npm ci(?:\s|$)/.test(command) && !/(?:^|\s)--ignore-scripts(?:\s|$)/.test(command)) {
        for (const name of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
          script(directory, name, false, false);
        }
      }
    }
  }

  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      const directory = repositoryPath(
        step['working-directory'] ?? job.defaults?.run?.['working-directory']
        ?? workflow.defaults?.run?.['working-directory'] ?? '.',
      );
      commands(step.run, directory);
    }
  }
  return files;
}

const workflowFor = (run: string, directory?: string) => JSON.stringify({
  jobs: { check: { steps: [{ run, ...(directory ? { 'working-directory': directory } : {}) }] } },
});

describe('a paths filter lists what the workflow depends on', () => {
  it('finds the filtered workflows at all (guards the guard)', () => {
    // A matcher that found none would make the rule below vacuous.
    const filtered = workflowsWithPathFilters();
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.map((w) => w.file)).toContain('supabase-production-migrations.yml');
  });

  it('resolves npm scripts to their files (calibrates the resolver)', () => {
    // Checked against a real entry, so the rule cannot pass by resolving nothing.
    const resolved = scriptsRunBy(workflowFor('npm run db:audit:queries'));
    expect(resolved.has('scripts/audit-supabase-queries.mjs')).toBe(true);
    expect(scriptsRunBy(workflowFor('npm run typecheck')).size).toBe(0);
  });

  it('every script a filtered workflow runs is in its paths', () => {
    const offenders: string[] = [];
    for (const { file, source, paths } of workflowsWithPathFilters()) {
      for (const script of scriptsRunBy(source)) {
        if (!paths.includes(script)) offenders.push(`${file} runs ${script} but does not list it`);
      }
    }
    expect(
      offenders,
      'a push that changes only this script will not re-run the workflow, so the gate '
      + 'silently stops gating until some other listed file changes:\n'
      + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('lists no script the workflow has stopped running', () => {
    // The list shrinks honestly too: a stale entry is a claim about a dependency
    // that no longer exists.
    for (const { file, source, paths } of workflowsWithPathFilters()) {
      const run = scriptsRunBy(source);
      // JSON/other support inputs need not themselves be executable scripts.
      for (const p of paths.filter((x) => /(^|\/)scripts\/.*\.mjs$/.test(x))) {
        expect(run.has(p), `${file} lists ${p} but no longer runs it`).toBe(true);
      }
    }
  });

  it('every path a filter names still exists', () => {
    // Three workflows pin SPECIFIC migration filenames — 0274_finance_…,
    // 0245_move_planner, 0270_travel_confirmation_import and friends. This
    // branch has renumbered a migration ten times (the tenth moved our own 0311
    // to 0433 to clear a collision with main), and a renumbering that lands on
    // one of these makes the filter match nothing. The workflow then never runs
    // again, and a runtime test that never runs looks exactly like one that
    // passes.
    //
    // Currently clean — 33 entries across 8 workflows all resolve. This is here
    // because the failure is silent and the repository has demonstrated the
    // mechanism that would cause it.
    const offenders: string[] = [];
    for (const { file, paths } of workflowsWithPathFilters()) {
      for (const p of paths) {
        if (!p.includes('/')) continue;
        const resolved = p.includes('*')
          ? globSync(join(ROOT, p)).length > 0
          : existsSync(join(ROOT, p));
        if (!resolved) offenders.push(`${file}: ${p}`);
      }
    }
    expect(
      offenders,
      'this paths: entry matches no file, so the workflow will never be triggered '
      + 'by it again. A renumbered migration is the usual cause, and the failure is '
      + 'silent — a runtime test that never runs looks like one that passes:\n'
      + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('is actually checking migration filenames (guards the guard)', () => {
    // Non-vacuity for the rule above: if no workflow pinned a migration any
    // more, it would be asserting over nothing and should be revisited.
    const pinned = workflowsWithPathFilters()
      .flatMap((w) => w.paths)
      .filter((p) => p.startsWith('supabase/migrations/') && p.endsWith('.sql'));
    expect(pinned.length).toBeGreaterThan(3);
  });

  it('the production migration workflow still gates the thing worth gating', () => {
    // Non-vacuity for the case that motivated this: if the db push step is ever
    // renamed or removed, the rules above stop being about production.
    const source = readFileSync(join(WORKFLOWS, 'supabase-production-migrations.yml'), 'utf8');
    expect(source).toContain('supabase db push --yes');
    expect(source).toContain("supabase/migrations/**");
  });
});

describe('path dependencies follow the package actually executed', () => {
  const packages: Record<string, Record<string, string>> = {
    '.': { check: 'node scripts/root.mjs' },
    mobile: {
      postinstall: 'node scripts/patch.mjs',
      precheck: 'npm run patch:check && npm run storage:test',
      check: 'node --test scripts/mobile.test.mjs',
      postcheck: 'node scripts/after.mjs',
      'patch:check': 'node scripts/patch.mjs --check',
      'storage:test': 'node --test scripts/storage.test.mjs',
    },
    tools: { check: 'node scripts/tools.mjs' },
  };
  const scriptsAt: ScriptLoader = (directory) => packages[directory] ?? {};

  it.each([
    ['workflow', { defaults: { run: { 'working-directory': 'mobile' } }, jobs: { check: { steps: [{ run: 'npm run check' }] } } }, 'mobile/scripts/mobile.test.mjs'],
    ['job overrides workflow', { defaults: { run: { 'working-directory': 'tools' } }, jobs: { check: { defaults: { run: { 'working-directory': 'mobile' } }, steps: [{ run: 'npm run check' }] } } }, 'mobile/scripts/mobile.test.mjs'],
    ['step overrides job', { defaults: { run: { 'working-directory': 'mobile' } }, jobs: { check: { defaults: { run: { 'working-directory': 'mobile' } }, steps: [{ run: 'npm run check', 'working-directory': 'tools' }] } } }, 'tools/scripts/tools.mjs'],
  ])('resolves %s working-directory without borrowing root scripts', (_name, workflow, expected) => {
    const resolved = scriptsRunBy(JSON.stringify(workflow), scriptsAt);
    expect(resolved.has(expected as string)).toBe(true);
    expect(resolved.has('scripts/root.mjs')).toBe(false);
  });

  it('follows npm pre/post hooks and nested scripts in that same package', () => {
    expect([...scriptsRunBy(workflowFor('npm run check', 'mobile'), scriptsAt)].sort()).toEqual([
      'mobile/scripts/after.mjs', 'mobile/scripts/mobile.test.mjs',
      'mobile/scripts/patch.mjs', 'mobile/scripts/storage.test.mjs',
    ]);
  });

  it('includes npm ci postinstall, but honours an explicit ignore-scripts', () => {
    expect([...scriptsRunBy(workflowFor('npm ci', 'mobile'), scriptsAt)]).toEqual(['mobile/scripts/patch.mjs']);
    expect([...scriptsRunBy(workflowFor('npm ci --ignore-scripts', 'mobile'), scriptsAt)]).toEqual([]);
  });

  it('fails instead of silently accepting a missing package script', () => {
    expect(() => scriptsRunBy(workflowFor('npm run absent', 'mobile'), scriptsAt)).toThrow('Missing npm script mobile:absent');
  });

  it('rejects recursive npm scripts instead of overflowing or omitting them', () => {
    expect(() => scriptsRunBy(workflowFor('npm run loop'), () => ({ loop: 'npm run loop' }))).toThrow('Cyclic npm script .:loop');
  });

  it('ignores comments and uses the cwd for direct node --test commands', () => {
    expect([...scriptsRunBy(workflowFor('# node scripts/comment.mjs\nnode --test scripts/direct.test.mjs', 'mobile'))])
      .toEqual(['mobile/scripts/direct.test.mjs']);
  });

  it('rejects a dynamic or escaping working directory rather than checking the wrong package', () => {
    for (const directory of ['${{ matrix.directory }}', '../outside']) {
      expect(() => scriptsRunBy(workflowFor('npm run check', directory), scriptsAt)).toThrow('Expected a literal repository path');
    }
  });

  it('discovers the real mobile install and typecheck dependencies independently of its paths list', () => {
    const source = readFileSync(join(WORKFLOWS, 'mobile-braces-depth-guard.yml'), 'utf8');
    expect([...scriptsRunBy(source)].sort()).toEqual([
      'mobile/scripts/auth-storage-errors.test.mjs',
      'mobile/scripts/braces-depth-guard.test.mjs',
      'mobile/scripts/device-signout-ownership.test.mjs',
      'mobile/scripts/patch-auth-storage-errors.mjs',
    ]);
    // The patcher and regression test both read this support file; it is not
    // an executable npm script, but changes to it must also trigger the gate.
    for (const event of Object.values(load(source).on ?? {})) {
      if (event?.paths) expect(event.paths).toContain('mobile/scripts/auth-storage-errors.patch.json');
    }
  });
});
