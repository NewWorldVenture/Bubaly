// A read tool is not harmless because its domain is not high-stakes.
//
// `executeTool` used to allow every read-only tool outside HIGH_STAKES_AI_DOMAINS
// before the trust engine ran, and 'travel' and 'education' are not in that
// list — so a guest ("View limited shared events only") or a child who asked
// Bubaly "what clashes with our trip?" was handed the family's unpaid bills,
// every child's homework and practice schedule and each traveller's passport
// expiry; "what is on the timetable?" named each child's teacher and room.
// Two layers that were supposed to stop it were inert: the view rule in
// `riskToDecision` was never reached, and ROLE_DEFAULTS.guest.sensitiveDomains
// was empty, so even when reached a guest was an unrestricted reader.
//
// Now: a restricted-read role's read is evaluated as `view`; a tool whose
// output is private is marked `sensitiveRead`; a guest has a real list of
// private domains; and the prompt context withholds the activities and travel
// slices from a guest. Parents and adults keep the fast path.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { executeTool } from '@/lib/ai/tools/execute';
import { getTool } from '@/lib/ai/tools/registry';
import { ROLE_DEFAULTS, riskToDecision } from '@/lib/trust/engine';
import { applySlicePolicy, canViewSlice, viewerFor } from '@/lib/ai/context/policy';

const FAMILY = 'fam-1';
let db: InMemorySupabase & SupabaseClient<Database>;

const scopeFor = (role: ServiceScope['role'], memberId = 'mem-reader'): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-reader', memberId, role, actorKind: 'member', tz: 'America/Los_Angeles', now: new Date('2026-10-05T16:00:00Z'),
});

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { vacation_members: { role: 'adult' }, school_classes: { week_pattern: 'all', room: null, time_slot: null, day_of_week: null } },
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
  });
  holder.db = db;
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', display_name: 'Alex', is_active: true, created_at: '2026-01-01' },
    { id: 'mem-child', family_id: FAMILY, user_id: null, role: 'child', display_name: 'Ava', is_active: true, created_at: '2026-01-02' },
    { id: 'mem-reader', family_id: FAMILY, user_id: 'user-reader', role: 'guest', display_name: 'Visitor', is_active: true, created_at: '2026-01-03' },
  ]);
  db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Tokyo', destination: 'Tokyo', kind: 'international', status: 'booked', start_date: '2026-11-01', end_date: '2026-11-08', timezone: 'Asia/Tokyo', is_international: true }]);
  db.seed('vacation_members', [{ id: 'vm-1', family_id: FAMILY, vacation_id: 'trip-1', member_id: 'mem-child', role: 'child' }]);
  db.seed('vacation_documents', [{ id: 'doc-1', family_id: FAMILY, vacation_id: 'trip-1', member_id: 'mem-child', kind: 'passport', title: 'Ava passport', expires_on: '2026-12-01' }]);
  db.seed('school_classes', [{ id: 'class-1', family_id: FAMILY, member_id: 'mem-child', subject: 'Maths', teacher: 'Mrs Okonkwo', room: '12', time_slot: '09:00', day_of_week: 1 }]);
  db.seed('teams', [{ id: 'team-1', family_id: FAMILY, member_id: 'mem-child', sport: 'soccer', team_name: 'Lions', coach: 'Coach Delgado', is_active: true }]);
  db.seed('school_events', [{ id: 'ev-1', family_id: FAMILY, member_id: 'mem-child', title: 'Bake sale', event_type: 'event', starts_at: '2026-10-07T17:00:00Z', ends_at: null, school_name: null }]);
});

const run = (role: ServiceScope['role'], tool: string, input: Record<string, unknown>) => executeTool(scopeFor(role), tool, input, { requestId: null });

describe('the engine itself: a guest is the most restricted reader, not the least', () => {
  it('gives the guest a real list of private domains', () => {
    for (const domain of ['education', 'homework', 'travel', 'passports', 'documents', 'finances', 'medical', 'emergency']) {
      expect(ROLE_DEFAULTS.guest.sensitiveDomains, domain).toContain(domain);
    }
    // ... while a guest can still read the shared surfaces the role is for.
    for (const domain of ['calendar', 'meal_planning', 'tasks', 'chores', 'shopping']) {
      expect(ROLE_DEFAULTS.guest.sensitiveDomains, domain).not.toContain(domain);
    }
    expect(ROLE_DEFAULTS.guest.capabilities).toEqual(['view']);
  });

  it('the view rule denies a guest a school read and leaves the shared calendar open', () => {
    const guest = { kind: 'member' as const, id: 'g', role: 'guest' as const };
    expect(riskToDecision({ risk: 'low', actor: guest, domain: 'education', capability: 'view' })).toMatchObject({ effect: 'deny', basis: 'risk_tier' });
    expect(riskToDecision({ risk: 'low', actor: guest, domain: 'travel', capability: 'view' })).toMatchObject({ effect: 'deny' });
    expect(riskToDecision({ risk: 'low', actor: guest, domain: 'calendar', capability: 'view' })).toBeNull();
  });

  it('a `sensitiveRead` tool is denied to a teen even in a domain the teen may otherwise read', () => {
    const teen = { kind: 'member' as const, id: 't', role: 'teen' as const };
    expect(riskToDecision({ risk: 'low', actor: teen, domain: 'travel', capability: 'view' })).toBeNull();
    expect(riskToDecision({ risk: 'low', actor: teen, domain: 'travel', capability: 'view', sensitiveRead: true })).toMatchObject({ effect: 'deny' });
  });

  it('marks the reads whose output is private by construction', () => {
    for (const name of ['trips.commitmentConflicts', 'trips.documentsRisk', 'trips.computeReadiness', 'school.listClasses', 'sports.listTeams', 'sports.listPracticesBetween']) {
      expect(getTool(name)?.sensitiveRead, name).toBe(true);
    }
  });
});

describe('executeTool: a restricted-read role does not skip the gate on a read', () => {
  it.each([
    ['trips.commitmentConflicts', { vacation_id: 'trip-1' }],
    ['trips.documentsRisk', { vacation_id: 'trip-1' }],
    ['trips.getTrip', { vacation_id: 'trip-1' }],
    ['school.listClasses', {}],
    ['sports.listTeams', {}],
    ['sports.listPracticesBetween', {}],
  ])('a guest asking %s is denied', async (tool, input) => {
    const outcome = await run('guest', tool, input);
    expect(outcome.status).toBe('denied');
    if (outcome.status !== 'denied') return;
    expect(outcome.reason).toMatch(/private to the adults/i);
  });

  it.each([
    ['trips.commitmentConflicts', { vacation_id: 'trip-1' }],
    ['trips.documentsRisk', { vacation_id: 'trip-1' }],
    ['school.listClasses', {}],
    ['sports.listPracticesBetween', {}],
  ])('a child asking %s is denied', async (tool, input) => {
    expect((await run('child', tool, input)).status).toBe('denied');
  });

  it('a teen is denied the aggregate that carries bills and passports, but keeps a plain school-events read', async () => {
    expect((await run('teen', 'trips.commitmentConflicts', { vacation_id: 'trip-1' })).status).toBe('denied');
    expect((await run('teen', 'trips.documentsRisk', { vacation_id: 'trip-1' })).status).toBe('denied');
    const events = await run('teen', 'school.listEventsBetween', { from: '2026-10-05', to: '2026-10-12' });
    expect(events.status).toBe('ok');
  });

  it('a parent still reads them, and the paperwork answer names the child', async () => {
    const classes = await run('parent', 'school.listClasses', {});
    expect(classes.status).toBe('ok');
    const risks = await run('parent', 'trips.documentsRisk', { vacation_id: 'trip-1' });
    expect(risks.status).toBe('ok');
    if (risks.status !== 'ok') return;
    expect(JSON.stringify(risks.data)).toContain("Ava's passport expires");
  });

  it('a denied read reaches no table the tool would have read', async () => {
    const reads: string[] = [];
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => { reads.push(name); return from(name); }) as typeof db.from);
    expect((await run('guest', 'trips.commitmentConflicts', { vacation_id: 'trip-1' })).status).toBe('denied');
    for (const table of ['bills', 'homework_assignments', 'school_events', 'sports_events', 'vacation_documents']) {
      expect(reads, table).not.toContain(table);
    }
    vi.restoreAllMocks();
  });
});

describe('the prompt context withholds the household slices from a guest', () => {
  it('a guest is not pre-loaded with the children\'s week or the family\'s trips', () => {
    const guest = viewerFor({ role: 'guest', memberId: 'g' });
    expect(canViewSlice('activities', guest)).toMatchObject({ allowed: false });
    expect(canViewSlice('travel', guest)).toMatchObject({ allowed: false });
    expect(applySlicePolicy(['people', 'activities', 'travel', 'schedule'], guest)).toEqual({ allowed: ['people', 'schedule'], omitted: ['activities', 'travel'] });
  });

  it('the household\'s own children, and its managers, keep them', () => {
    for (const role of ['child', 'teen', 'caregiver', 'parent', 'adult'] as const) {
      const viewer = viewerFor({ role, memberId: 'm' });
      expect(canViewSlice('activities', viewer), role).toEqual({ allowed: true });
      expect(canViewSlice('travel', viewer), role).toEqual({ allowed: true });
    }
  });
});
