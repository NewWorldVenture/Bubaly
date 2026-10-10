import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * THE ASSISTANT TELLS A CHILD ONLY WHAT A CHILD IS SHOWN (AI-001).
 *
 * Home, Needs You and the daily briefing read a family's pending money
 * approvals (`parent_approvals`: what was asked for and how much) and the
 * count of chores awaiting sign-off for a MANAGER only; a child's list is
 * built with neither. Row-level security does not draw that line —
 * `parent_approvals_select` (0251) is any member — so the pages draw it
 * themselves.
 *
 * Bubaly's `list_pending_decisions` read both for whoever was talking to it.
 * A child asking "what needs me?" heard about a sibling's $50 request and was
 * asked to sign off chores they cannot sign off.
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa11';
const PARENT = '00000000-0000-4000-8000-00000000ad11';
const KID = '00000000-0000-4000-8000-00000000c111';
const SIBLING_USER = '00000000-0000-4000-8000-00000000aa12';

function household() {
  const db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('parent_approvals', [{
    id: '00000000-0000-4000-8000-0000000000a1', family_id: FAMILY, kind: 'spend', amount_cents: 5000,
    status: 'pending', requested_by: SIBLING_USER, created_at: '2026-10-09T12:00:00.000Z',
  }]);
  db.seed('chore_assignments', [
    { id: '00000000-0000-4000-8000-0000000000b1', family_id: FAMILY, status: 'submitted' },
    { id: '00000000-0000-4000-8000-0000000000b2', family_id: FAMILY, status: 'submitted' },
  ]);
  db.seed('grocery_items', [{ id: '00000000-0000-4000-8000-0000000000c1', family_id: FAMILY, is_checked: false }]);
  return db;
}

const ctxFor = (role: string | null, memberId: string): AssistantCtx => ({
  familyId: FAMILY, userId: `${memberId}-user`, memberId, role,
  members: [{ id: PARENT, display_name: 'Dana' }, { id: KID, display_name: 'Sam' }], tz: 'UTC',
});

async function pending(role: string | null, memberId: string) {
  const tool = buildAssistantTools(household() as never, ctxFor(role, memberId)).find((t) => t.name === 'list_pending_decisions');
  if (!tool) throw new Error('list_pending_decisions missing');
  const res = await tool.execute({}) as { ok: boolean; items: { title: string }[] };
  expect(res.ok).toBe(true);
  return res.items.map((i) => i.title);
}

describe('list_pending_decisions follows the pages\' role rule', () => {
  it('a parent hears the money request and the chores waiting on them', async () => {
    const titles = await pending('parent', PARENT);
    expect(titles.some((t) => t.includes('$50')), JSON.stringify(titles)).toBe(true);
    expect(titles).toContain('2 chores awaiting approval');
  });

  it('an adult manager hears them too', async () => {
    const titles = await pending('adult', PARENT);
    expect(titles.some((t) => t.includes('$50')), JSON.stringify(titles)).toBe(true);
    expect(titles).toContain('2 chores awaiting approval');
  });

  for (const role of ['child', 'teen', 'caregiver', 'guest', null]) {
    it(`a ${role ?? 'roleless'} caller hears neither, and still hears the rest`, async () => {
      const titles = await pending(role, KID);
      expect(titles.some((t) => t.includes('$50') || /approv/i.test(t)), JSON.stringify(titles)).toBe(false);
      // Not an empty answer: what any member is shown is still there.
      expect(titles).toContain('Grocery list needs updating');
    });
  }
});

describe('every chat entry point says who is asking', () => {
  const ROOT = join(__dirname, '..');
  it('both callers that execute the tools pass the caller\'s role', () => {
    const chat = readFileSync(join(ROOT, 'app/api/ai/chat/route.ts'), 'utf8');
    const engine = readFileSync(join(ROOT, 'lib/ai/assistant-engine.ts'), 'utf8');
    expect(chat).toMatch(/buildAssistantTools\(supabase, \{[^}]*role: ctx\.active\.role/);
    expect(engine).toMatch(/buildAssistantTools\(supabase, \{[^}]*role: input\.role/);
  });
});
