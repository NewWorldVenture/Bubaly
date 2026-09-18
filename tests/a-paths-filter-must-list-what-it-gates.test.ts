import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
}).scripts;

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
    const head = source.split(/\npermissions:|\njobs:/)[0];
    if (!/^\s+paths:/m.test(head)) continue;
    out.push({ file, source, paths: [...head.matchAll(/^\s+- '([^']+)'/gm)].map((m) => m[1]) });
  }
  return out;
}

/** Every `scripts/*.mjs` a workflow runs, directly or through an npm script. */
function scriptsRunBy(source: string): Set<string> {
  const files = new Set<string>([...source.matchAll(/node (scripts\/[\w.-]+)/g)].map((m) => m[1]));
  for (const [, name] of source.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
    for (const m of (scripts[name] ?? '').matchAll(/(scripts\/[\w.-]+\.mjs)/g)) files.add(m[1]);
  }
  return files;
}

describe('a paths filter lists what the workflow depends on', () => {
  it('finds the filtered workflows at all (guards the guard)', () => {
    // A matcher that found none would make the rule below vacuous.
    const filtered = workflowsWithPathFilters();
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.map((w) => w.file)).toContain('supabase-production-migrations.yml');
  });

  it('resolves npm scripts to their files (calibrates the resolver)', () => {
    // Checked against a real entry, so the rule cannot pass by resolving nothing.
    const resolved = scriptsRunBy('run: npm run db:audit:queries');
    expect(resolved.has('scripts/audit-supabase-queries.mjs')).toBe(true);
    expect(scriptsRunBy('run: npm run typecheck').size).toBe(0);
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
      for (const p of paths.filter((x) => x.startsWith('scripts/'))) {
        expect(run.has(p), `${file} lists ${p} but no longer runs it`).toBe(true);
      }
    }
  });

  it('the production migration workflow still gates the thing worth gating', () => {
    // Non-vacuity for the case that motivated this: if the db push step is ever
    // renamed or removed, the rules above stop being about production.
    const source = readFileSync(join(WORKFLOWS, 'supabase-production-migrations.yml'), 'utf8');
    expect(source).toContain('supabase db push --yes');
    expect(source).toContain("supabase/migrations/**");
  });
});
