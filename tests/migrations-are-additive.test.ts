import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Prod-safety ratchet (mandate: migrations must be additive + idempotent; agents
// cannot apply to prod, and the pending set gets applied by a human later). A
// migration that DROP TABLE / DROP COLUMN / TRUNCATE would DESTROY production
// data when that human runs `supabase db push`. The whole migration history is
// verified additive at authoring time (0 destructive statements); this guard
// fails CI if a destructive one is ever introduced. Dropping POLICY / TRIGGER /
// FUNCTION / INDEX (recreated right after) is fine and NOT flagged.
const DIR = 'supabase/migrations';

// Strip -- line comments and /* */ block comments so prose never trips the scan.
function stripSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

// Mask only the TRUNCATE event in a complete statement-trigger declaration.
// Never remove the statement, its called function, or any following SQL.
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?`;
const TRUNCATE_TRIGGER_EVENT = new RegExp(
  `(\\bcreate\\s+(?:or\\s+replace\\s+)?trigger\\s+${IDENTIFIER}\\s+(?:before|after)\\s+)`
    + `truncate(?=\\s+on\\s+${QUALIFIED_IDENTIFIER}\\s+for\\s+each\\s+statement\\s+execute\\s+(?:function|procedure)\\s+${QUALIFIED_IDENTIFIER}\\s*\\()`
  , 'gi',
);

const DESTRUCTIVE: [string, RegExp][] = [
  ['DROP TABLE', /\bdrop\s+table\b/i],
  ['DROP COLUMN', /\bdrop\s+column\b/i],
  ['TRUNCATE', /\btruncate\b/i],
  // ALTER TYPE ... DROP VALUE isn't valid PG, but DROP TYPE of an in-use enum is destructive.
  ['DROP TYPE', /\bdrop\s+type\b(?!\s+if\s+exists\s+\w*_?tmp)/i],
];

function destructiveLabels(source: string): string[] {
  const sql = stripSql(source).replace(TRUNCATE_TRIGGER_EVENT, '$1__trigger_event__');
  return DESTRUCTIVE.filter(([, expression]) => expression.test(sql)).map(([label]) => label);
}

describe('protective TRUNCATE trigger declarations', () => {
  it.each([
    'CREATE TRIGGER guard BEFORE TRUNCATE ON public.history FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();',
    'CREATE OR REPLACE TRIGGER "Audit guard" AFTER TRUNCATE ON public."History" FOR EACH STATEMENT EXECUTE FUNCTION public."Reject mutation"();',
  ])('allows the event declaration: %s', (sql) => {
    expect(destructiveLabels(sql)).toEqual([]);
  });

  it.each([
    'TRUNCATE public.history;',
    'TRUNCATE TABLE public.history;',
    'TRUNCATE ONLY public.history RESTART IDENTITY;',
    'DO $$ BEGIN TRUNCATE TABLE public.history; END $$;',
    'CREATE FUNCTION bad() RETURNS void LANGUAGE plpgsql AS $$ BEGIN TRUNCATE TABLE public.history; END $$;',
    'CREATE TRIGGER guard BEFORE TRUNCATE ON public.history FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation(); TRUNCATE TABLE public.history;',
    'CREATE TRIGGER incomplete BEFORE TRUNCATE ON public.history;',
  ])('still rejects destructive or unrecognized SQL: %s', (sql) => {
    expect(destructiveLabels(sql)).toContain('TRUNCATE');
  });

  it('preserves every other destructive-statement check after a declaration', () => {
    expect(destructiveLabels('CREATE TRIGGER guard BEFORE TRUNCATE ON public.history FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation(); DROP TABLE public.history; ALTER TABLE public.moves DROP COLUMN title; DROP TYPE public.member_role;'))
      .toEqual(['DROP TABLE', 'DROP COLUMN', 'DROP TYPE']);
  });
});


describe('migrations are additive (no destructive DDL)', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

  it('scans the full migration history', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('contains no DROP TABLE / DROP COLUMN / TRUNCATE / DROP TYPE', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const label of destructiveLabels(readFileSync(`${DIR}/${f}`, 'utf8'))) {
        offenders.push(`${f} :: ${label}`);
      }
    }
    expect(offenders, `destructive DDL found (would delete prod data on apply):\n${offenders.join('\n')}`).toEqual([]);
  });
});
