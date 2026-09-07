// Pet prep, at both ends: the workflow skeleton that asks for it, and the
// service that produces one task per animal from the `pets` table (0083).
//
// The bug this pins shut is the one the audit found: "pets covered" as a single
// line on the home checklist. Two dogs and a diabetic cat are three different
// arrangements, and a sitter needs the NAME and the care notes, not a reminder
// that animals exist. A failed read must not look like "no pets", either — that
// is how something gets left alone for a week.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { instantiateTemplate, templateContextFrom, templateFor, type TemplateContext } from '@/lib/ai/planner/templates/index';
import { parseStepInput } from '@/lib/ai/planner/schema';
import { getTool } from '@/lib/ai/tools/registry';
import { createPetCareTasks, petPrep } from '@/lib/services/trips';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'fam-1';

function scopeFor(db: unknown): ServiceScope {
  return {
    db: db as SupabaseClient<Database>,
    familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz: 'UTC',
  };
}

function withFailingTable(db: InMemorySupabase, failing: string): unknown {
  const reply = { data: null, error: { code: 'XX000', message: `${failing} unavailable`, details: null, hint: null }, count: null };
  const proxy: unknown = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (onFulfilled: (value: unknown) => unknown) => Promise.resolve(reply).then(onFulfilled);
      return () => proxy;
    },
  });
  return { from: (name: string) => (name === failing ? proxy : db.from(name)) };
}

function seeded() {
  const db = createInMemorySupabase({
    defaults: { todo_items: { is_done: false, tags: [], priority: 'medium', notes: null, due_date: null } },
  });
  db.seed('vacations', [{
    id: 'trip-1', family_id: FAMILY, title: 'Barcelona', destination: 'Barcelona', kind: 'flight',
    status: 'booked', start_date: '2026-07-14', end_date: '2026-07-20', timezone: 'UTC',
  }]);
  db.seed('pets', [
    { id: 'pet-dog', family_id: FAMILY, name: 'Rufus', species: 'dog', notes: 'Two walks a day, hates fireworks', vet_name: 'Dr Vale', vet_phone: '555-0100', is_active: true },
    { id: 'pet-cat', family_id: FAMILY, name: 'Mika', species: 'cat', notes: 'Insulin at 08:00 and 20:00', vet_name: null, vet_phone: null, is_active: true },
    { id: 'pet-gone', family_id: FAMILY, name: 'Old Bess', species: 'dog', notes: null, vet_name: null, vet_phone: null, is_active: false },
    { id: 'pet-other', family_id: 'fam-2', name: 'Someone else', species: 'dog', notes: null, vet_name: null, vet_phone: null, is_active: true },
  ]);
  db.seed('todo_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Family', is_default: true }]);
  return db;
}

describe('petPrep', () => {
  it('produces one task per ACTIVE pet in this family, named and annotated', async () => {
    const res = await petPrep(scopeFor(seeded()), 'trip-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tasks.map((t) => t.petName)).toEqual(['Mika', 'Rufus']);
    const rufus = res.data.tasks.find((t) => t.petName === 'Rufus')!;
    expect(rufus.title).toBe('Arrange care for Rufus during Barcelona');
    expect(rufus.notes).toContain('Two walks a day, hates fireworks');
    expect(rufus.notes).toContain('Dr Vale');
    expect(rufus.notes).toContain('555-0100');
    // The sitter has to be arranged before anyone leaves.
    expect(rufus.dueDate).toBe('2026-07-13');
  });

  it('carries the care notes that make a sitter useful, per animal', async () => {
    const res = await petPrep(scopeFor(seeded()), 'trip-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const mika = res.data.tasks.find((t) => t.petName === 'Mika')!;
    expect(mika.notes).toContain('Insulin at 08:00 and 20:00');
    expect(mika.notes).not.toContain('Two walks');
  });

  it('fails closed when the pets table cannot be read, instead of reporting no pets', async () => {
    const res = await petPrep(scopeFor(withFailingTable(seeded(), 'pets')), 'trip-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();
  });
});

describe('createPetCareTasks', () => {
  it('writes one to-do per pet, each carrying that pet’s notes', async () => {
    const db = seeded();
    const res = await createPetCareTasks(scopeFor(db), 'trip-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.pets).toBe(2);
    expect(res.data.created).toHaveLength(2);

    const todos = db.table('todo_items') as Record<string, unknown>[];
    expect(todos).toHaveLength(2);
    expect(todos.map((t) => t.title).sort()).toEqual([
      'Arrange care for Mika during Barcelona',
      'Arrange care for Rufus during Barcelona',
    ]);
    const rufus = todos.find((t) => String(t.title).includes('Rufus'))!;
    expect(String(rufus.notes)).toContain('Two walks a day');
    expect(rufus.due_date).toBe('2026-07-13');
    expect(rufus.family_id).toBe(FAMILY);
  });

  it('does not collapse several pets into one task when the caller supplies an idempotency key', async () => {
    const db = seeded();
    const scope = { ...scopeFor(db), idempotencyKey: 'req-42' };
    const first = await createPetCareTasks(scope, 'trip-1');
    expect(first.ok).toBe(true);
    expect((db.table('todo_items') as unknown[]).length).toBe(2);

    // The same request replayed writes nothing new.
    const again = await createPetCareTasks(scope, 'trip-1');
    expect(again.ok).toBe(true);
    expect((db.table('todo_items') as unknown[]).length).toBe(2);
  });

  it('writes nothing when the family has no pets on file', async () => {
    const db = createInMemorySupabase();
    db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Barcelona', kind: 'flight', status: 'planning', start_date: '2026-07-14', end_date: '2026-07-20', timezone: 'UTC' }]);
    const res = await createPetCareTasks(scopeFor(db), 'trip-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ created: [], pets: 0 });
    expect(db.table('todo_items')).toEqual([]);
  });
});

// ── the workflow skeleton ────────────────────────────────────────────────────

function ctx(): TemplateContext {
  return templateContextFrom({
    tz: 'America/New_York', nowIso: '2026-09-05T16:00:00Z', todayKey: '2026-09-05',
    requestText: 'Get us ready for the Barcelona trip',
    viewerMemberId: 'mem-parent', managerIds: ['mem-parent'],
    trips: [{ id: 'trip-1', title: 'Barcelona', startDate: '2026-10-10', daysUntil: 35 }],
  });
}

describe('the prepare-vacation workflow', () => {
  const plan = instantiateTemplate(templateFor('prepare_vacation')!, ctx());

  it('reads the pets and creates a task per pet, both bound to the trip', () => {
    const pets = plan.steps.find((s) => s.key === 'pets')!;
    const petCare = plan.steps.find((s) => s.key === 'pet_care')!;
    expect(pets.tool_name).toBe('trips.petPrep');
    expect(petCare.tool_name).toBe('trips.createPetCareTasks');
    for (const step of [pets, petCare]) {
      const input = parseStepInput(step.input);
      expect(input.ok && input.value.vacation_id, step.key).toBe('trip-1');
    }
    expect(petCare.depends_on).toContain('pets');
  });

  it('registers both pet tools, the read as read-only and the write as a create', () => {
    const read = getTool('trips.petPrep')!;
    const write = getTool('trips.createPetCareTasks')!;
    expect(read.readOnly).toBe(true);
    expect(write.readOnly).toBe(false);
    expect(write.capability).toBe('create');
    expect(typeof write.idempotencyFrom).toBe('function');
  });

  it('stops promising "pets covered" on the one home checklist line', () => {
    const checklist = plan.steps.find((s) => s.key === 'home_checklist')!;
    const input = parseStepInput(checklist.input);
    expect(input.ok && String(input.value.title)).not.toContain('pets');
  });

  it('follows up on the trip being disrupted, without promising a rebooking', () => {
    const followup = plan.followups.find((f) => /disrupted/i.test(f.prompt));
    expect(followup, 'a Trip disrupted follow-up exists').toBeDefined();
    expect(followup!.prompt).toContain('trips.replanDisruption');
    expect(followup!.prompt).toMatch(/do not say anything was rebooked/i);
    // The earlier two-days-before follow-up keeps its slot.
    expect(plan.followups[0].after).toBe('2026-10-08T09:00:00');
  });

  it('exposes the disruption re-flow as a read-only tool: the write path stays the server action', () => {
    const tool = getTool('trips.replanDisruption')!;
    expect(tool.readOnly).toBe(true);
    expect(tool.capability).toBe('view');
    expect(tool.domain).toBe('travel');
  });
});
