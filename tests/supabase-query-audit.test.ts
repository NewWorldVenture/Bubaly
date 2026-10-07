import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  auditSupabaseQueries,
  readSchema,
  auditRpcCalls,
  RESERVED_RPC_DEPENDENCIES,
} from '../scripts/audit-supabase-queries.mjs';

type Finding = { kind: string; detail: string; file: string; line: number; via?: string };

describe('supabase query audit', () => {
  it('allows the source audit but blocks the production CLI on held RPC dependencies', () => {
    const run = (args: string[]) => spawnSync(process.execPath,
      ['scripts/audit-supabase-queries.mjs', ...args], { encoding: 'utf8' });
    const normal = run([]);
    expect(normal.error).toBeUndefined();
    expect(normal.status).toBe(0);
    expect(normal.stdout).toContain('No unapproved statically named query problems.');
    expect(normal.stderr).toContain('Approved held RPC dependencies');
    expect(normal.stderr).not.toContain('Runnable RPC gate failed');
    const strict = run(['--require-runnable-rpcs']);
    expect(strict.error).toBeUndefined();
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('Runnable RPC gate failed: 4 held RPC call site(s)');
    expect(strict.stderr).toContain('Production migration workflow is blocked');
    for (const [name, approval] of Object.entries(RESERVED_RPC_DEPENDENCIES) as [string, { sql: string }][]) {
      expect(strict.stderr).toContain(name);
      expect(strict.stderr).toContain(approval.sql);
    }
    expect(strict.stderr).toContain('Dynamic RPC names not resolved by this static audit');
    expect(strict.stdout).toContain('production function availability is unverified');
  });

  it('requires runnable RPCs before applying while retaining metadata-only verification', () => {
    const workflow = readFileSync('.github/workflows/supabase-production-migrations.yml', 'utf8').replaceAll('\r\n', '\n');
    const gate = workflow.indexOf('run: npm run db:audit:queries -- --require-runnable-rpcs');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(workflow.indexOf('run: supabase link'));
    expect(workflow).toContain('run: npm run db:audit:queries\n');
    const step = workflow.slice(workflow.lastIndexOf('- name:', gate), gate);
    expect(step).toContain("if: success() && github.event_name == 'workflow_dispatch' && inputs.apply == true");
    expect(gate).toBeLessThan(workflow.indexOf('run: supabase db push --yes'));
  });

  it('reports no unapproved findings while keeping held dependencies separate', () => {
    const { findings, schema, reservedDependencies } = auditSupabaseQueries() as {
      findings: Finding[];
      schema: { functions: Set<string> };
      reservedDependencies: (Finding & { migration: string; runnable: boolean })[];
    };
    const describeFinding = (f: Finding) => `${f.kind} ${f.detail} at ${f.file}:${f.line}`;
    expect(findings.map(describeFinding)).toEqual([]);
    expect(reservedDependencies).toHaveLength(4);
    for (const [name, approval] of Object.entries(RESERVED_RPC_DEPENDENCIES) as [
      string,
      { caller: string; sql: string },
    ][]) {
      expect(schema.functions.has(name), 'held function must not enter the runnable schema').toBe(false);
      expect(reservedDependencies).toContainEqual(
        expect.objectContaining({
          detail: name,
          file: approval.caller,
          migration: approval.sql,
          runnable: false,
          kind: 'reserved-function',
        }),
      );
    }
  });

  it('still sees a real schema, not an empty one', () => {
    // A parser regression that silently produced zero tables would make the
    // audit above pass vacuously, which is the only way this gate can rot.
    const { columns, functions } = auditSupabaseQueries().schema;
    expect(columns.size).toBeGreaterThan(400);
    expect(functions.size).toBeGreaterThan(50);
    expect(columns.get('meal_plans')).toContain('plan_date');
    expect(columns.get('meal_plans')).not.toContain('planned_for');
    expect(columns.get('chores')).not.toContain('assignee_id');
  });

  describe('held RPC dependency controls', () => {
    const name = 'count_family_ai_requests_month';
    const caller = 'lib/server/ai-access.ts';
    const path = 'supabase/reserved/0493_ai_copy_private_read_and_quota.sql';
    function candidate(sql: string, candidatePath = path) {
      const root = mkdtempSync(join(tmpdir(), 'bubaly-held-rpc-'));
      const location = join(root, candidatePath);
      mkdirSync(dirname(location), { recursive: true });
      writeFileSync(location, sql);
      return root;
    }
    const definition =
      'create or replace function public.count_family_ai_requests_month(p_family_id uuid) returns integer language sql as $$ select 0 $$;';

    it('recognizes the exact approved function/caller/candidate without resolving it', () => {
      const functions = new Set<string>();
      const result = auditRpcCalls(
        "db.rpc('count_family_ai_requests_month', {});",
        caller,
        functions,
        candidate(definition),
      );
      expect(result.findings).toEqual([]);
      expect(result.reservedDependencies).toHaveLength(1);
      expect(result.reservedDependencies[0]).toMatchObject({
        detail: name,
        migration: path,
        runnable: false,
      });
      expect(functions.size).toBe(0);
    });

    it.each(['unapproved_rpc', 'constructor', 'toString'])(
      'does not approve nonexistent function %s',
      (rpc) => {
        const result = auditRpcCalls(`db.rpc('${rpc}', {});`, caller, new Set(), candidate(definition));
        expect(result.findings).toMatchObject([{ kind: 'missing-function', detail: rpc }]);
        expect(result.reservedDependencies).toEqual([]);
      },
    );

    it('an approved name at an unapproved caller still fails', () => {
      const result = auditRpcCalls(
        `db.rpc('${name}', {});`,
        'lib/other.ts',
        new Set(),
        candidate(definition),
      );
      expect(result.findings).toMatchObject([{ kind: 'missing-function', file: 'lib/other.ts' }]);
      expect(result.reservedDependencies).toEqual([]);
    });

    it.each([
      ['missing candidate', '', 'supabase/reserved/unapproved.sql'],
      ['wrong function', 'create function public.other_rpc() returns integer language sql as $$$$;', path],
      ['comment only', '-- ' + definition, path],
      ['wrong schema', definition.replace('public.', 'private.'), path],
      ['wrong reserved path', definition, 'supabase/reserved/9999_candidate.sql'],
    ])('does not silently skip %s', (_label, sql, candidatePath) => {
      const result = auditRpcCalls(
        `db.rpc('${name}', {});`,
        caller,
        new Set(),
        candidate(sql, candidatePath),
      );
      expect(result.findings).toMatchObject([
        { kind: 'missing-function', detail: name, reservedCandidate: path },
      ]);
      expect(result.reservedDependencies).toEqual([]);
    });

    it('checks constant-bound RPCs including the held feed function', () => {
      const root = candidate(
        'create or replace function public.calendar_feed_apply_sync() returns boolean language sql as $$ select true $$;',
        'supabase/reserved/0490_a_calendar_feed_sync_writes_only_while_it_holds_its_claim.sql',
      );
      const result = auditRpcCalls(
        "export const APPLY_SYNC_FUNCTION = 'calendar_feed_apply_sync';\ndb.rpc(APPLY_SYNC_FUNCTION, {});",
        'lib/server/calendar-feeds.ts',
        new Set(),
        root,
      );
      expect(result.findings).toEqual([]);
      expect(result.reservedDependencies).toMatchObject([
        { detail: 'calendar_feed_apply_sync', line: 2, runnable: false },
      ]);
      const negative = auditRpcCalls(
        "const CALL = 'nonexistent_rpc'; db.rpc(CALL, {});",
        caller,
        new Set(),
        root,
      );
      expect(negative.findings).toMatchObject([{ kind: 'missing-function', detail: 'nonexistent_rpc' }]);
    });

    it('reports an opaque dynamic name explicitly without approving or resolving it', () => {
      const result = auditRpcCalls('db.rpc(runtimeFunction, {});', caller, new Set(), candidate(definition));
      expect(result.reservedDependencies).toEqual([]);
      expect(result.unresolvedRpcCalls).toMatchObject([
        { kind: 'unresolved-rpc', file: caller, line: 1, detail: 'runtimeFunction' },
      ]);
    });

    it('a function in runnable migrations is resolved without a held classification', () => {
      const result = auditRpcCalls(`db.rpc('${name}', {});`, caller, new Set([name]), candidate(''));
      expect(result.findings).toEqual([]);
      expect(result.reservedDependencies).toEqual([]);
    });

    it('never imports an unrelated function from approved reserved SQL', () => {
      const root = candidate(
        definition +
          '\ncreate function public.unapproved_rpc() returns integer language sql as $$select 0$$;',
      );
      const result = auditRpcCalls("db.rpc('unapproved_rpc', {});", caller, new Set(), root);
      expect(result.findings).toMatchObject([{ kind: 'missing-function', detail: 'unapproved_rpc' }]);
      expect(result.reservedDependencies).toEqual([]);
    });
  });

  describe('schema parsing', () => {
    const parse = (sql: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'bubaly-schema-'));
      writeFileSync(join(dir, '0001_test.sql'), sql);
      return readSchema(dir);
    };

    it('reads columns from create table and later add column', () => {
      const { columns } = parse(`
        create table if not exists public.widgets (
          id uuid primary key default gen_random_uuid(),
          family_id uuid not null references public.families(id),
          label text not null,
          unique (family_id, label)
        );
        alter table public.widgets add column if not exists retired_at timestamptz;
      `);
      expect([...columns.get('widgets')].sort()).toEqual(['family_id', 'id', 'label', 'retired_at']);
    });

    it('does not mistake a table constraint for a column', () => {
      const { columns } = parse(`
        create table public.gadgets (
          id uuid primary key,
          name text,
          constraint gadgets_name_key unique (name),
          check (name <> '')
        );
      `);
      expect(columns.get('gadgets')).not.toContain('constraint');
      expect(columns.get('gadgets')).not.toContain('check');
    });

    it('recognises a quoted policy name', () => {
      // `CREATE POLICY "Authenticated read invest_assets" ON …` is a real shape
      // in this repo. Missing it reports a policied table as deny-all.
      const { withPolicy } = parse(`
        create table public.catalog (id uuid primary key, is_active boolean);
        alter table public.catalog enable row level security;
        create policy "Authenticated read catalog" on public.catalog
          for select to authenticated using (is_active = true);
      `);
      expect(withPolicy.has('catalog')).toBe(true);
    });
  });
});
