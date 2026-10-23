// The privacy export names what it leaves out.
//
// Settings › Privacy › "Download export" builds twelve sections (family,
// members, calendar, todos, memories, documents, trips, groceries, school,
// sports, routines, finances). Its only omission list was `withheld`, which
// names the sections a ROLE does not get; it said nothing about the modules the
// export never reads at all. Against the migrations' member-keyed tables, that
// was most of them — journal, health, locations, credentials, wallet, care log,
// behaviour, screen time, sleep, kid logins, trust grants and the rest — while
// the Privacy Center promised "a JSON file of what your role can see" and the
// privacy policy "a copy of your family's data". A parent relying on the file
// before closing the account had none of those records and no statement that
// they were left out.
//
// The file now carries `notIncluded`, the ledger row records it, the Privacy
// Center says so under the button, and the inventory behind it
// (lib/privacy/export-coverage.ts) is held to the migrations here: every table
// carrying a `member_id` is either read by a section or named as not included,
// so a module added tomorrow is an honest omission from the day it ships.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { at } from './helpers/source-order';
import { render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { createElement } from 'react';
import type { ServiceScope } from '@/lib/services/types';
import type { UserContext } from '@/lib/supabase/auth';

const mocks = vi.hoisted(() => ({ getUserContext: vi.fn(), createServer: vi.fn(), ledgerWriter: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: mocks.getUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/trust/ledger', () => ({ ledgerWriter: mocks.ledgerWriter }));

// The Privacy Center, driven through the harness: the real component and the
// real en-US catalogue; its session read answers a password-only session.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const ui = vi.hoisted(() => ({ app: {} as Record<string, unknown>, db: null as unknown }));
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/card', async () => ({ Card: (await import('./helpers/module-harness')).ui.Badge }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ui.app }));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtDateTime: (value: string) => value }) }));
vi.mock('@/components/auth/sign-out-form', () => ({ SignOutForm: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => (ui.db as { from: (t: string) => unknown }).from(table),
    auth: {
      getUser: async () => ({ data: { user: { id: 'user', last_sign_in_at: null } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    },
  }),
}));

import { EXPORT_SECTIONS, buildFamilyExport } from '@/lib/privacy/export';
import { EXPORT_NOT_INCLUDED, EXPORT_NOT_INCLUDED_TABLES, EXPORT_SECTION_TABLES } from '@/lib/privacy/export-coverage';
import { GET } from '@/app/api/privacy/export/route';
import { PrivacyCenter } from '@/components/settings/privacy-center';

const MIGRATIONS = 'supabase/migrations';

/** Every table a migration creates with, or later gives, a `member_id uuid` column. */
function memberKeyedTables(): Set<string> {
  const tables = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/^\s*member_id\s+uuid/im.test(match[2])) tables.add(match[1]);
    }
    for (const match of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?member_id\s+uuid/gi)) {
      tables.add(match[1]);
    }
  }
  return tables;
}

const FAMILY = 'fam-1';
const sameOriginFetch = () => new NextRequest('https://app.example.invalid/api/privacy/export', {
  headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'application/json' },
});

function household(): InMemorySupabase {
  const db = createInMemorySupabase({ userId: 'user-parent', rpc: { rate_limit_hit: () => [{ allowed: true, retry_after: 0 }] } });
  Object.assign(db.auth, {
    getSession: async () => ({ data: { session: { access_token: 'synthetic-assurance-token' } }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
  });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Jordan', role: 'parent', is_active: true, birthday: null, color: null, avatar_url: null },
    { id: 'mem-teen', family_id: FAMILY, user_id: 'user-teen', display_name: 'Sam', role: 'teen', is_active: true, birthday: '2011-04-02', color: null, avatar_url: null },
  ]);
  return db;
}

const scopeFor = (db: InMemorySupabase, role: 'parent' | 'teen'): ServiceScope => ({
  db: db as unknown as ServiceScope['db'], familyId: FAMILY,
  userId: role === 'parent' ? 'user-parent' : 'user-teen', memberId: role === 'parent' ? 'mem-parent' : 'mem-teen',
  role, actorKind: 'member', tz: 'UTC',
});
const ctxFor = (role: 'parent' | 'teen'): UserContext => ({
  user: { id: role === 'parent' ? 'user-parent' : 'user-teen', email: `${role}@example.com` },
  memberships: [],
  active: { familyId: FAMILY, role, member: { id: role === 'parent' ? 'mem-parent' : 'mem-teen' }, family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' } },
} as unknown as UserContext);

beforeEach(() => {
  mocks.getUserContext.mockReset();
  mocks.createServer.mockReset();
  mocks.ledgerWriter.mockReset().mockImplementation(async (fallback: unknown) => fallback);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/**
 * Member-keyed tables no application code reads or writes: AUTHZ-020's
 * unreferenced sixteen, held unreferenced by
 * tests/authz-020-unreferenced-tables-stay-unreferenced.test.ts. The app never
 * puts a family's data in them, so there is nothing for the export to leave
 * out, and naming one in lib/ would trip that tripwire.
 */
const NEVER_WRITTEN_BY_THE_APP = new Set(['sync_event_attendees', 'vacation_notifications']);

describe('the inventory behind notIncluded, held to the migrations', () => {
  const read = new Set(Object.values(EXPORT_SECTION_TABLES).flat());
  const named = Object.values(EXPORT_NOT_INCLUDED_TABLES).flat();
  const keyed = memberKeyedTables();

  it('scans the real schema (guards the guard)', () => {
    expect(keyed.size).toBeGreaterThan(100);
    expect(keyed.has('journal_entries')).toBe(true);
    expect(keyed.has('family_credentials')).toBe(true);
  });

  it('names a section for every section the export reads, and nothing else', () => {
    expect(Object.keys(EXPORT_SECTION_TABLES).sort()).toEqual(EXPORT_SECTIONS.map((s) => s.key).sort());
  });

  it('every member-keyed table is either read by a section or named as not included', () => {
    const unaccounted = [...keyed].filter((table) => !read.has(table) && !named.includes(table) && !NEVER_WRITTEN_BY_THE_APP.has(table)).sort();
    expect(unaccounted, 'add each to a section\'s reads or to EXPORT_NOT_INCLUDED_TABLES').toEqual([]);
  });

  it('the tables it leaves unnamed are member-keyed, and named by no application code', () => {
    for (const table of NEVER_WRITTEN_BY_THE_APP) {
      expect(keyed.has(table), table).toBe(true);
      expect(named.includes(table) || read.has(table), table).toBe(false);
    }
  });

  it('names no table twice, none a section already reads, and none the schema does not have', () => {
    expect(new Set(named).size).toBe(named.length);
    expect(named.filter((table) => read.has(table))).toEqual([]);
    expect(named.filter((table) => !keyed.has(table)).sort(), 'a table named as not included must carry member_id in the migrations').toEqual([]);
  });

  it('the file\'s module list is the inventory\'s keys, and names the modules the finding named', () => {
    expect([...EXPORT_NOT_INCLUDED]).toEqual(Object.keys(EXPORT_NOT_INCLUDED_TABLES));
    for (const name of ['health', 'journal', 'locations', 'credentials', 'wallet', 'careLog', 'behavior', 'screenTime', 'sleep', 'kidLogins', 'trustGrants']) {
      expect(EXPORT_NOT_INCLUDED).toContain(name);
    }
  });
});

describe('the export file', () => {
  it.each(['parent', 'teen'] as const)('carries notIncluded for a %s, beside withheld', async (role) => {
    const built = await buildFamilyExport(scopeFor(household(), role));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data.notIncluded).toEqual([...EXPORT_NOT_INCLUDED]);
    expect(built.data.notIncluded.length).toBeGreaterThan(10);
    expect(built.data.withheld).toEqual(role === 'parent' ? [] : ['finances']);
  });
});

describe('the route and the ledger', () => {
  it('streams notIncluded in the file and records it on the ledger row', async () => {
    const db = household();
    mocks.getUserContext.mockResolvedValue(ctxFor('parent'));
    mocks.createServer.mockResolvedValue(db);
    const res = await GET(sameOriginFetch());
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.notIncluded).toEqual([...EXPORT_NOT_INCLUDED]);
    const context = db.table('trust_audit_logs')[0].context as { notIncluded: string[]; withheld: string[] };
    expect(context.notIncluded).toEqual([...EXPORT_NOT_INCLUDED]);
    expect(context.withheld).toEqual([]);
  });
});

describe('what the Privacy Center says, rendered', () => {
  const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

  it('no longer promises "what your role can see", and names the modules the file covers', () => {
    expect(EN_US['privacyCenter.exportHelp']).not.toMatch(/what your role can see/);
    for (const word of ['calendar', 'documents', 'finances']) expect(EN_US['privacyCenter.exportHelp']).toContain(word);
  });

  it.each(['parent', 'teen'])('a %s reads, between the help and the export button, what is not in the file', (role) => {
    resetHookSlots(h.hooks);
    ui.db = household();
    ui.app = { familyId: FAMILY, userId: `user-${role}`, userEmail: `${role}@example.com`, role, members: [] };
    const screen = text(render(h.hooks, createElement(PrivacyCenter)));
    const help = at(screen, EN_US['privacyCenter.exportHelp']);
    const notIncluded = at(screen, EN_US['privacyCenter.exportNotIncluded']);
    expect(notIncluded).toBeGreaterThan(help);
    expect(at(screen, EN_US['privacyCenter.exportButton'])).toBeGreaterThan(notIncluded);
    for (const word of ['health', 'journal', 'locations', 'wallet', 'listed inside the file']) expect(EN_US['privacyCenter.exportNotIncluded']).toContain(word);
    // The file's field name is for the file; the reader is told where to look in plain words.
    expect(screen).not.toContain('notIncluded');
  });

  it('in every base catalogue', () => {
    for (const locale of ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(messages['privacyCenter.exportNotIncluded'], locale).toBeTruthy();
      expect(messages['privacyCenter.exportNotIncluded'], locale).not.toContain('notIncluded');
      expect(messages['privacyCenter.exportNotIncluded'], locale).not.toBe(EN_US['privacyCenter.exportNotIncluded']);
      expect(messages['privacyCenter.exportHelp'], locale).not.toBe(EN_US['privacyCenter.exportHelp']);
    }
  });
});
