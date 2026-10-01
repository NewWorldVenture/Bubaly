// App protections from #674, independently runnable before migration 0465.
// These four source/copy assertions are separated from its mixed SQL/UI test;
// that original test and its SQL assertions stay with the migration.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isManager } from '@/lib/constants/roles';
import { getMessages } from '@/lib/i18n/messages';
import { LOCALES as SUPPORTED_LOCALES } from '@/lib/i18n/locales';
import { at } from './helpers/source-order';

const read = (file: string) => readFileSync(file, 'utf8');
const MEDS = read('components/modules/medications-module.tsx');
const COACH = read('app/api/ai/health/coach/route.ts');
const HEALTH = read('components/modules/health-module.tsx');
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const KEYS = ['medicationsModule.yourOwnMedicinesOnly', 'medicationsModule.noMedicinesPrescribedToYou', 'coach.onlyYourOwnHealth'];

describe('prescription app privacy before 0465', () => {
  it('explains the own-only list, hides irrelevant filters and preserves dose actions', () => {
    expect(MEDS).toContain('const canEdit = isManager(role);');
    expect(MEDS).toMatch(/\{canEdit \? \(\s*<div className="flex flex-wrap gap-1\.5 mb-4[\s\S]*?WHOLE_FAMILY[\s\S]*?\) : \(\s*<p className="text-sm text-muted mb-4">\{t\('medicationsModule\.yourOwnMedicinesOnly'\)\}<\/p>/);
    expect(MEDS).toContain("description={canEdit ? t('uiText.addAMedicationAndSetItsDosing') : t('medicationsModule.noMedicinesPrescribedToYou')}");
    expect(MEDS).toMatch(/async function logDose\(due: DueDose, status: DoseStatus\) \{\s*if \(!canMutate\(\)\) return;/);
    expect(MEDS).toMatch(/await mutate\(`dose:\$\{due\.scheduleId\}:\$\{due\.slotKey\}`, false,/);
  });

  it('requests own rows and includes that scope in both query identities', () => {
    expect(MEDS).toContain('const ownMemberOnly = canEdit ? null : (selfMember?.id ?? NIL_UUID);');
    expect(MEDS).toContain("const NIL_UUID = '00000000-0000-0000-0000-000000000000';");
    expect(MEDS).toMatch(/table: 'medications', familyId, deps: \[familyId, ownMemberOnly\],\s*fetcher: \(sb\) => \{\s*const q = sb\.from\('medications'\)\.select\('\*'\)\.eq\('family_id', familyId\);\s*return \(ownMemberOnly \? q\.eq\('member_id', ownMemberOnly\) : q\)/);
    expect(MEDS).toMatch(/table: 'medication_doses', familyId, deps: \[familyId, dayKey, ownMemberOnly\],[\s\S]{0,200}?return ownMemberOnly \? q\.eq\('member_id', ownMemberOnly\) : q;/);
  });

  it('refuses someone else before health reads and restricts the coach picker', () => {
    expect(COACH).toContain('if (memberId && !manager && memberId !== ctx.active.member.id) {');
    expect(COACH).toContain('const manager = isManager(ctx.active.role);');
    expect(COACH).toContain("return NextResponse.json({ error: t('coach.onlyYourOwnHealth') }, { status: 403 });");
    expect(at(COACH, "t('coach.onlyYourOwnHealth')")).toBeLessThan(at(COACH, "supabase.from('medications')"));
    expect(HEALTH).toContain('(isManager(role) ? members : members.filter((m) => m.user_id === userId))');
    expect(HEALTH).toContain('{coachMembers.map((m) =>');
  });

  it('includes the copy in every full catalogue and resolves regional fallbacks', () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of KEYS) expect(messages[key], `${locale} ${key}`).toBeTruthy();
    }
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of KEYS) expect(getMessages(locale.code)[key], `${locale.code} ${key}`).toBeTruthy();
    }
  });
});

// Execute the actual query callbacks and own-member initializer from the module,
// not a second handwritten version of its filters. The SDK's custom transport
// deliberately applies ONLY requested filters: it models the broad pre-0465
// read policy, so a missing member filter returns the synthetic sibling rows.
const source = ts.createSourceFile('medications-module.tsx', MEDS, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fetchers = new Map<string, string>();
let ownMemberInitializer = 'undefined'; // Old-source counterfactual has no own-member scope.
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'ownMemberOnly' && node.initializer) {
    ownMemberInitializer = node.initializer.getText(source);
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useRealtimeQuery') {
    const options = node.arguments[0];
    if (options && ts.isObjectLiteralExpression(options)) {
      const props = options.properties.filter(ts.isPropertyAssignment);
      const table = props.find(p => p.name.getText(source) === 'table')?.initializer;
      const fetcher = props.find(p => p.name.getText(source) === 'fetcher')?.initializer;
      if (table && ts.isStringLiteral(table) && fetcher) fetchers.set(table.text, fetcher.getText(source));
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);

const FAMILY = 'family-fixture';
const SELF = 'member-self';
const SIBLING = 'member-sibling';
const NIL = '00000000-0000-0000-0000-000000000000';
const since = '2026-09-01T00:00:00.000Z';
const rows = [
  { id: 'own-row', family_id: FAMILY, member_id: SELF, scheduled_for: '2026-09-30T00:00:00.000Z' },
  { id: 'sibling-row', family_id: FAMILY, member_id: SIBLING, scheduled_for: '2026-09-30T00:00:00.000Z' },
  { id: 'unassigned-row', family_id: FAMILY, member_id: null, scheduled_for: '2026-09-30T00:00:00.000Z' },
  { id: 'foreign-row', family_id: 'other-family', member_id: SELF, scheduled_for: '2026-09-30T00:00:00.000Z' },
];

afterEach(() => vi.unstubAllGlobals());

async function query(table: 'medications' | 'medication_doses', role: string, memberId: string | null = SELF) {
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected real network request'); });
  const ownMemberOnly = new Function('canEdit', 'selfMember', 'NIL_UUID', `return (${ownMemberInitializer});`)(
    isManager(role), memberId ? { id: memberId } : null, NIL,
  );
  const text = fetchers.get(table);
  if (!text) throw new Error(`Missing actual fetcher for ${table}`);
  const compiled = ts.transpileModule(`const fetcher = ${text};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const fetcher = new Function('familyId', 'ownMemberOnly', 'windowStart', `${compiled}\nreturn fetcher;`)(FAMILY, ownMemberOnly, since);
  const requests: URL[] = [];
  const client = createClient('https://fixture.invalid', 'synthetic-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://fixture.invalid' || url.pathname !== `/rest/v1/${table}` || (init?.method ?? 'GET') !== 'GET') {
        throw new Error('Unexpected fixture request');
      }
      requests.push(url);
      const visible = rows.filter(row => [...url.searchParams].every(([key, value]) => {
        if (key === 'select' || key === 'order') return true;
        if (value.startsWith('eq.')) return String(row[key as keyof typeof row]) === value.slice(3);
        if (key === 'scheduled_for' && value.startsWith('gte.')) return row.scheduled_for >= value.slice(4);
        throw new Error('Unexpected fixture filter');
      }));
      return Response.json(visible);
    } },
  });
  const result = await fetcher(client) as { data: typeof rows | null; error: unknown };
  expect(result.error).toBeNull();
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
  if (table === 'medication_doses') expect(requests[0].searchParams.get('scheduled_for')).toBe(`gte.${since}`);
  return { ids: result.data?.map(row => row.id), request: requests[0] };
}

describe.each(['medications', 'medication_doses'] as const)('%s before restrictive read policies', table => {
  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s requests and receives only their own rows', async role => {
    const result = await query(table, role);
    expect(result.request.searchParams.get('member_id')).toBe(`eq.${SELF}`);
    expect(result.ids).toEqual(['own-row']);
  });

  it.each(['parent', 'adult'])('a %s retains the whole-family query', async role => {
    const result = await query(table, role);
    expect(result.request.searchParams.has('member_id')).toBe(false);
    expect(result.ids).toEqual(['own-row', 'sibling-row', 'unassigned-row']);
  });

  it('a missing self member cannot widen the query', async () => {
    const result = await query(table, 'child', null);
    expect(result.request.searchParams.get('member_id')).toBe(`eq.${NIL}`);
    expect(result.ids).toEqual([]);
  });

  it('another own-member scope in the same family is a different request', async () => {
    expect((await query(table, 'child', SELF)).ids).toEqual(['own-row']);
    const next = await query(table, 'child', SIBLING);
    expect(next.request.searchParams.get('member_id')).toBe(`eq.${SIBLING}`);
    expect(next.ids).toEqual(['sibling-row']);
  });
});
