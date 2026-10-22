import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * THE ASSISTANT IS TOLD WHO IS ASKING, AND A ROLE NOBODY HAS IS NOT A
 * MANAGER (AI-001).
 *
 * `list_pending_decisions` reads pending money approvals and the chore
 * sign-off count for a parent or adult only (main, 88c67b771, and
 * tests/pending-decisions-keep-money-for-the-managers.test.ts); an unknown
 * role is not a manager. That rule is only as good as the role the caller
 * hands it.
 *
 * /api/ai/chat passes the member's role. The assistant engine
 * (`prepareAssistantTurn`, behind /api/ai) passed `scope.role`, which falls
 * back to 'adult' when the caller is not on the roster and the request names
 * no role: the one caller nobody can vouch for was handed the household's
 * money decisions as a manager. The engine now passes the caller's REAL role,
 * or null.
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa11';
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
  ]);
  return db;
}

const ctxFor = (role: string | null): AssistantCtx => ({
  familyId: FAMILY, userId: `${KID}-user`, memberId: KID, role,
  members: [{ id: KID, display_name: 'Sam' }], tz: 'UTC',
});

describe('a caller whose role is not known', () => {
  it('is not handed the money approvals or the sign-off count', async () => {
    const tool = buildAssistantTools(household() as never, ctxFor(null)).find((t) => t.name === 'list_pending_decisions');
    if (!tool) throw new Error('list_pending_decisions missing');
    const res = await tool.execute({}) as { ok: boolean; items: { title: string }[] };
    expect(res.ok).toBe(true);
    const titles = res.items.map((i) => i.title);
    expect(titles.some((t) => t.includes('$50') || /approv/i.test(t)), JSON.stringify(titles)).toBe(false);
  });
});

describe('every chat entry point says who is asking', () => {
  const ROOT = join(__dirname, '..');
  it('both callers that execute the tools pass the caller\'s role', () => {
    const chat = readFileSync(join(ROOT, 'app/api/ai/chat/route.ts'), 'utf8');
    const engine = readFileSync(join(ROOT, 'lib/ai/assistant-engine.ts'), 'utf8');
    expect(chat).toMatch(/buildAssistantTools\(supabase, \{[^}]*role: ctx\.active\.role/);
    // Not scope.role, which falls back to 'adult' when no role is known.
    expect(engine).toMatch(/buildAssistantTools\(supabase, \{[^}]*role: acting\?\.role \?\? input\.role \?\? null/);
  });
});
