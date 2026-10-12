// The planner's dry run promises to decide "exactly what lib/ai/tools/execute.ts
// gate() would decide". When the executor stopped waving every
// non-high-stakes read through for a teen, child, caregiver or guest, the dry
// run kept the old early allow: a teen's "plan our week" passed planning with a
// practices read the run then denied, so the run failed mid-way and blocked
// everything that depended on it, instead of leaving the step out at plan time
// with a reason. Both now ask one helper (lib/trust/engine.ts
// readSkipsTrustGate), and this drives the planner and the REAL executor over
// the same reads and requires them to agree.
//
// It also pins which household rules can lift that denial, because the gate's
// comment claimed "a grant" could: every executor surface runs as the AI
// actor, and per-member grants, delegations and member-subject policies only
// ever match a member actor. A role (or everyone, or AI) policy does.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { Policy } from '@/lib/trust/engine';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { executeTool } from '@/lib/ai/tools/execute';
import { getTool, listTools } from '@/lib/ai/tools/registry';
import { catalogueNames, dryRunGate, validatePlan, type ValidationInputs } from '@/lib/ai/planner/validate';
import type { Plan, PlanStep } from '@/lib/ai/planner/schema';

const FAMILY = 'fam-1';
const NOW = new Date('2026-10-05T16:00:00Z');
let db: InMemorySupabase & SupabaseClient<Database>;

/** The run executor's scope: the AI acting for the person who asked. */
const runScope = (role: ServiceScope['role']): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-reader', memberId: 'mem-reader', role, actorKind: 'ai', tz: 'America/Los_Angeles', now: NOW,
});
const inputsFor = (role: ValidationInputs['role'], policies: Policy[] = []): ValidationInputs => ({
  policies, grants: [], delegations: [], emergencyDomains: [], role, now: NOW, tz: 'America/Los_Angeles', allowedTools: catalogueNames(listTools()),
});

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { school_classes: { week_pattern: 'all', room: null, time_slot: null, day_of_week: null } },
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
  });
  holder.db = db;
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', display_name: 'Alex', is_active: true, created_at: '2026-01-01' },
    { id: 'mem-reader', family_id: FAMILY, user_id: 'user-reader', role: 'teen', display_name: 'Sam', is_active: true, created_at: '2026-01-03' },
  ]);
  db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Tokyo', destination: 'Tokyo', kind: 'international', status: 'booked', start_date: '2026-11-01', end_date: '2026-11-08', timezone: 'Asia/Tokyo', is_international: true }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const READS: [string, Record<string, unknown>][] = [
  ['sports.listPracticesBetween', {}],
  ['sports.listTeams', {}],
  ['school.listClasses', {}],
  ['school.listEventsBetween', { from: '2026-10-05', to: '2026-10-12' }],
  ['trips.getTrip', { vacation_id: 'trip-1' }],
  ['trips.computeReadiness', { vacation_id: 'trip-1' }],
  ['calendar.searchEvents', {}],
];
const ROLES = ['teen', 'child', 'caregiver', 'guest', 'parent', 'adult'] as const;

describe('the dry run and the executor give one answer for every private read', () => {
  for (const role of ROLES) {
    it.each(READS)(`${role}: %s`, async (name, input) => {
      const tool = getTool(name)!;
      const planned = dryRunGate(tool, input, inputsFor(role), null);
      const ran = await executeTool(runScope(role), name, input, { requestId: null });
      expect(ran.status === 'denied', `${role} ${name}: run said ${ran.status}, plan said ${planned.effect}`).toBe(planned.effect === 'deny');
    });
  }

  it('the denials are the ones the trust engine names: sensitive reads for every restricted role, a guest\'s school and trips, a child\'s trips', () => {
    const denied = (role: (typeof ROLES)[number], name: string) => dryRunGate(getTool(name)!, {}, inputsFor(role), null).effect === 'deny';
    for (const role of ['teen', 'child', 'caregiver', 'guest'] as const) {
      expect(denied(role, 'sports.listPracticesBetween'), role).toBe(true);
      expect(denied(role, 'school.listClasses'), role).toBe(true);
    }
    expect(denied('guest', 'school.listEventsBetween')).toBe(true);
    expect(denied('guest', 'trips.getTrip')).toBe(true);
    expect(denied('child', 'trips.getTrip')).toBe(true);
    expect(denied('teen', 'school.listEventsBetween')).toBe(false);
    expect(denied('parent', 'sports.listPracticesBetween')).toBe(false);
  });
});

describe('a restricted role\'s plan leaves the private read out at plan time, with its dependants', () => {
  const step = (partial: Partial<PlanStep> & { key: string }): PlanStep => ({
    step_type: 'retrieve', tool_name: null, description: partial.key, input: '{}', depends_on: [], condition: null, approval_required: null, verify: null, ...partial,
  });
  const weekPlan = (): Plan => ({
    objective: 'Plan our week', reasoning_summary: 'Practices first, then a reminder.', risk_level: 'low', followups: [], clarification: null, answer: null,
    steps: [
      step({ key: 'practices', tool_name: 'sports.listPracticesBetween', input: '{"from":"2026-10-05","to":"2026-10-12"}' }),
      step({ key: 'remind', step_type: 'act', tool_name: 'reminders.create', input: '{"title":"Pack the kit bag","remind_at":"2026-10-06T07:00:00"}', depends_on: ['practices'] }),
      step({ key: 'events', tool_name: 'calendar.searchEvents', input: '{}' }),
    ],
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('%s: "practices" is left out at plan time with the reason, not failed at run time', (role) => {
    const result = validatePlan(weekPlan(), inputsFor(role));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.key)).not.toContain('practices');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'denied', step: 'practices', reason: expect.stringMatching(/private to the adults/) }));
    // The shared calendar read is not private, and stays.
    expect(result.steps.map((s) => s.key)).toContain('events');
  });

  it('a teen\'s reminder, which the teen may set, is dropped WITH the read it depends on — not left to fail mid-run', () => {
    const result = validatePlan(weekPlan(), inputsFor('teen'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.key)).toEqual(['events']);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'denied', step: 'practices' }),
      expect.objectContaining({ code: 'dependency_dropped', step: 'remind' }),
    ]));
  });

  it('a parent\'s plan keeps both', () => {
    const result = validatePlan(weekPlan(), inputsFor('parent'));
    expect(result.ok && result.steps.map((s) => s.key)).toEqual(expect.arrayContaining(['practices', 'remind']));
  });
});

describe('which household rules lift the private-read denial for the assistant', () => {
  const policyRow = (subject: Record<string, unknown>) => ({
    id: `pol-${String(subject.subject_kind)}`, family_id: FAMILY, domain: 'education', capability: 'view', effect: 'allow',
    enabled: true, priority: 100, conditions: {}, approval_model: 'single', required_approvals: 1, ...subject,
  });

  it('a per-member grant or a policy naming the member does not — the run acts as the AI', async () => {
    db.seed('permission_grants', [{ family_id: FAMILY, member_id: 'mem-reader', domain: 'education', capability: 'view', effect: 'allow' }]);
    db.seed('trust_policies', [policyRow({ subject_kind: 'member', subject_member_id: 'mem-reader' })]);
    expect((await executeTool(runScope('teen'), 'sports.listPracticesBetween', {}, { requestId: null })).status).toBe('denied');
  });

  it('a policy for the role does, and the planner agrees', async () => {
    db.seed('trust_policies', [policyRow({ subject_kind: 'role', subject_role: 'teen' })]);
    expect((await executeTool(runScope('teen'), 'sports.listPracticesBetween', {}, { requestId: null })).status).toBe('ok');
    const policy: Policy = {
      id: 'pol-role', domain: 'education', capability: 'view', subjectKind: 'role', subjectRole: 'teen', subjectMemberId: null,
      effect: 'allow', conditions: {}, approvalModel: 'single', requiredApprovals: 1, priority: 100, enabled: true,
    };
    expect(dryRunGate(getTool('sports.listPracticesBetween')!, {}, inputsFor('teen', [policy]), null).effect).toBe('allow');
  });

  it('the gate says so, instead of promising that "a grant" can win', () => {
    const src = readFileSync('lib/ai/tools/execute.ts', 'utf8');
    expect(src).not.toContain("where a household's own grant or policy for that domain can still win");
    expect(src).toContain('A per-member permission grant,');
    expect(src).toContain('a delegation, or a policy naming one member does NOT');
  });
});
