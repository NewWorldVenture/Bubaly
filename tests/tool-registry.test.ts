// The registry is a closed set with metadata the trust engine and the executor
// depend on, so these are contract tests over the whole catalogue rather than
// example tests: a tool added later without a domain, without a risk tier,
// without a duplicate guard on a create, or with an input schema the provider
// cannot be told about, fails here rather than in front of a family.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTool, listTools, toolNames, functionName } from '@/lib/ai/tools/registry';
import { toToolSpecs, toolInputSchema } from '@/lib/ai/tools/legacy-adapter';
import { CAPABILITIES, TRUST_DOMAINS } from '@/lib/trust/engine';
import type { ServiceScope } from '@/lib/services/types';

const ALL = listTools();

/** OpenAI's function-name rule; a name that breaks it is silently rejected at request time. */
const FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe('registry shape', () => {
  it('registers a non-empty, uniquely named catalogue', () => {
    expect(ALL.length).toBeGreaterThan(0);
    expect(new Set(toolNames()).size).toBe(ALL.length);
  });

  it('names every tool domain.verb', () => {
    for (const tool of ALL) expect(tool.name).toMatch(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/);
  });

  it('gives every tool a real trust domain, capability and risk tier', () => {
    for (const tool of ALL) {
      expect(TRUST_DOMAINS).toContain(tool.domain);
      expect(CAPABILITIES).toContain(tool.capability);
      expect(['low', 'medium', 'high']).toContain(tool.risk);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.summarize).toBe('function');
    }
  });

  it('keeps readOnly and capability honest with each other', () => {
    for (const tool of ALL) {
      if (tool.readOnly) expect(tool.capability).toBe('view');
      else expect(tool.capability).not.toBe('view');
    }
  });

  it('gives every create a duplicate guard, so a retried run cannot write it twice', () => {
    for (const tool of ALL.filter((t) => !t.readOnly && t.capability === 'create')) {
      expect(typeof tool.idempotencyFrom, `${tool.name} needs idempotencyFrom`).toBe('function');
    }
  });

  it('explains every high-risk tool, because an approval card with no consequences is unanswerable', () => {
    for (const tool of ALL.filter((t) => t.risk === 'high')) {
      const consequences = tool.consequences?.({});
      expect(Array.isArray(consequences) && consequences.length > 0, `${tool.name} needs consequences`).toBe(true);
    }
  });
});

describe('name resolution', () => {
  it('resolves canonical, underscored and case-shifted spellings to the same tool', () => {
    const canonical = getTool('calendar.createEvent');
    expect(canonical?.name).toBe('calendar.createEvent');
    expect(getTool('calendar_createEvent')).toBe(canonical);
    expect(getTool('CALENDAR.CREATEEVENT')).toBe(canonical);
    expect(getTool('  calendar.createEvent  ')).toBe(canonical);
  });

  it('keeps every legacy flat name executing — stored approval payloads depend on it', () => {
    const expected: Record<string, string> = {
      create_calendar_event: 'calendar.createEvent',
      add_chore: 'tasks.createChore',
      create_chore: 'tasks.createChore',
      add_grocery_item: 'groceries.addItems',
      add_todo: 'tasks.createTodo',
      add_reminder: 'reminders.create',
      create_reminder: 'reminders.create',
      complete_reminder: 'reminders.complete',
      snooze_reminder: 'reminders.snooze',
      list_upcoming_events: 'calendar.searchEvents',
      list_open_chores: 'tasks.listOpenChores',
      get_grocery_list: 'groceries.listOpen',
      find_free_time: 'calendar.findFreeSlots',
    };
    for (const [alias, canonical] of Object.entries(expected)) {
      expect(getTool(alias)?.name, alias).toBe(canonical);
    }
  });

  it('returns null for anything it does not know, so the executor can default-deny', () => {
    expect(getTool('finances.transferMoney')).toBeNull();
    expect(getTool('')).toBeNull();
    expect(getTool(undefined as unknown as string)).toBeNull();
  });
});

describe('listTools filters', () => {
  it('separates reads from writes', () => {
    const reads = listTools({ readOnly: true });
    const writes = listTools({ readOnly: false });
    expect(reads.length + writes.length).toBe(ALL.length);
    expect(reads.every((t) => t.readOnly)).toBe(true);
    expect(writes.every((t) => !t.readOnly)).toBe(true);
  });

  it('filters by domain and by name, accepting legacy names', () => {
    expect(listTools({ domains: ['shopping'] }).every((t) => t.domain === 'shopping')).toBe(true);
    expect(listTools({ names: ['add_todo', 'calendar.createEvent'] }).map((t) => t.name).sort())
      .toEqual(['calendar.createEvent', 'tasks.createTodo']);
  });
});

describe('provider adapter', () => {
  it('can express every tool input as strict JSON Schema, so no tool is silently withheld', () => {
    for (const tool of ALL) {
      const schema = toolInputSchema(tool);
      expect(schema, `${tool.name} input schema`).not.toBeNull();
      expect(schema?.type).toBe('object');
      // Strict mode: no extra keys, and every key listed as required.
      expect(schema?.additionalProperties).toBe(false);
      expect(Object.keys(schema?.properties as Record<string, unknown> ?? {}).sort())
        .toEqual([...(schema?.required as string[] ?? [])].sort());
    }
  });

  it('emits provider-safe function names for every tool', () => {
    const scope = { familyId: 'fam-1', db: {} as SupabaseClient<Database> } as unknown as ServiceScope;
    const specs = toToolSpecs(scope);
    expect(specs).toHaveLength(ALL.length);
    for (const spec of specs) {
      expect(spec.name).toMatch(FUNCTION_NAME);
      expect(typeof spec.execute).toBe('function');
    }
    expect(specs.map((s) => s.name)).toContain(functionName('calendar.createEvent'));
  });

  it('narrows the toolbox when asked', () => {
    const scope = { familyId: 'fam-1', db: {} as SupabaseClient<Database> } as unknown as ServiceScope;
    expect(toToolSpecs(scope, { names: ['add_grocery_item'] }).map((s) => s.name)).toEqual(['groceries_addItems']);
  });
});
