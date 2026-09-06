import { describe, it, expect, vi, beforeEach } from 'vitest';

// A-15 AI-assistant tool authorization guard. The chat assistant can execute REAL
// family actions (add chore, create calendar event, post announcement, …). Since
// children have real logins and can chat with the assistant, the authorization
// boundary is `wrapToolsWithTrust`: every WRITE tool must be routed through the
// family Trust & Permissions Engine with the caller's role BEFORE it writes —
// deny blocks the write, require_approval defers to a parent (no write), allow
// executes. Read tools pass through. This test locks that enforcement so a
// regression can't let a tool write without a trust check.

const evaluateTrust = vi.fn();
const openedApprovals = vi.fn<(...args: unknown[]) => string | null>(() => 'appr-1');
vi.mock('@/lib/trust/server', () => ({
  evaluateTrust: (...args: unknown[]) => evaluateTrust(...args),
  // The wrapper files its own approval row when the risk tier tightens an
  // engine `allow`; the test watches for that rather than a database.
  openApprovalRequest: (...args: unknown[]) => Promise.resolve(openedApprovals(...args)),
  // roleOf is pure; a faithful stub keeps the wrapper's actor role meaningful.
  roleOf: (r: string | null | undefined) => (r === 'parent' || r === 'adult' ? 'guardian' : 'member'),
}));

import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import { approvalIdFromToolResult } from '@/lib/ai/result-cards';
import type { ToolSpec } from '@/lib/ai/provider';

/**
 * Just enough client for the wrapper: it reads `family_ai_settings` before it
 * gates anything, because "Switch Bubaly off" has to reach the surface a
 * family actually talks to.
 */
function supabaseWith(settings: Record<string, unknown> | null) {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const reply = { data: table === 'family_ai_settings' ? settings : null, error: null };
    Object.assign(b, {
      select: () => b, eq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
      insert: () => b, update: () => b,
      single: () => Promise.resolve({ data: { id: 'appr-1' }, error: null }),
      maybeSingle: () => Promise.resolve(reply),
      then: (resolve: (v: unknown) => void) => resolve(reply),
    });
    return b;
  };
  return { from } as never;
}

const AI_ON = { family_id: 'fam-1', enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true };
const fakeSupabase = supabaseWith(AI_ON);

function makeTool(name: string): { spec: ToolSpec; inner: ReturnType<typeof vi.fn> } {
  const inner = vi.fn(async (args: Record<string, unknown>) => ({ ok: true, wrote: name, args }));
  const spec: ToolSpec = { name, description: name, input_schema: {}, execute: inner };
  return { spec, inner };
}

function wrapOne(name: string, role: string | null = 'child', supabase = fakeSupabase) {
  const { spec, inner } = makeTool(name);
  const [wrapped] = wrapToolsWithTrust([spec], supabase, 'fam-1', role);
  return { wrapped, inner };
}

beforeEach(() => {
  evaluateTrust.mockReset();
  openedApprovals.mockReset();
  openedApprovals.mockReturnValue('appr-1');
});

describe('A-15 wrapToolsWithTrust gates every write tool', () => {
  it('DENY: the underlying write never runs and the child is told it was blocked', async () => {
    evaluateTrust.mockResolvedValue({ decision: { effect: 'deny', reason: 'children cannot post announcements' } });
    const { wrapped, inner } = wrapOne('create_announcement', 'child');
    const res = (await wrapped.execute({ title: 'Party' })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked by household policy/i);
    expect(inner).not.toHaveBeenCalled();
  });

  it('REQUIRE_APPROVAL: no write happens, and the result names the row a parent can act on', async () => {
    evaluateTrust.mockResolvedValue({ decision: { effect: 'require_approval', reason: 'needs a parent' }, approvalId: 'appr-1' });
    const { wrapped, inner } = wrapOne('add_chore', 'child');
    const res = await wrapped.execute({ title: 'Mow lawn' });
    expect(inner).not.toHaveBeenCalled();
    // The SHAPE is the assertion. `approvalIdFromToolResult` reads snake_case
    // `pending_approval` plus `approval_id`; the wrapper used to return
    // camelCase `pendingApproval` with the id dropped, so the chip said "sent
    // for parent approval" and no card was ever built from it. A truthy flag
    // alone is not enough — that is exactly what shipped broken.
    expect(res).toMatchObject({ ok: true, pending_approval: true, approval_id: 'appr-1' });
    expect(approvalIdFromToolResult(res)).toBe('appr-1');
  });

  it('REQUIRE_APPROVAL with no row filed is a failure, not a queue', async () => {
    // gateAiAction hands back approvalId: null when the insert failed. Nothing
    // was written and nobody was asked, so "sent for parent approval" would be
    // a promise with nothing behind it — and the child would wait forever for
    // a decision no parent can see.
    evaluateTrust.mockResolvedValue({ decision: { effect: 'require_approval', reason: 'needs a parent' } });
    openedApprovals.mockReturnValue(null);
    const { wrapped, inner } = wrapOne('add_chore', 'child');
    const res = (await wrapped.execute({ title: 'Mow lawn' })) as { ok: boolean; error?: string };
    expect(inner).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not send that for approval/i);
    expect(approvalIdFromToolResult(res)).toBeNull();
  });

  it('drops the cannot-replay caveat from the tools whose approvals now execute', async () => {
    // add_note used to say "a parent will need to add it by hand", because
    // approving it failed at replay — nothing outside lib/assistant/tools.ts
    // wrote `notes`. `notes.create` resolves that alias now, so the approval
    // executes and the caveat would be a lie.
    evaluateTrust.mockResolvedValue({ decision: { effect: 'require_approval', reason: 'needs a parent' }, approvalId: 'appr-9' });
    for (const name of ['add_note', 'add_goal', 'add_chore']) {
      const { wrapped } = wrapOne(name, 'child');
      const res = (await wrapped.execute({ body: 'x', title: 'x' })) as { ok: boolean; summary: string };
      expect(res, name).toMatchObject({ ok: true, pending_approval: true, approval_id: 'appr-9' });
      expect(res.summary, `${name} still warns about a replay that now works`).not.toMatch(/by hand/i);
    }
  });

  it('keeps the caveat on rsvp_to_event, whose approval still cannot execute', async () => {
    // Deliberately still an orphan: the replay runs under the APPROVER's scope
    // and the approval row records no asker, so a registry RSVP tool would
    // answer for the parent and its upsert would overwrite that parent's own
    // reply. The family is told up front instead.
    evaluateTrust.mockResolvedValue({ decision: { effect: 'require_approval', reason: 'needs a parent' }, approvalId: 'appr-9' });
    const { wrapped } = wrapOne('rsvp_to_event', 'child');
    const res = (await wrapped.execute({ event_title: 'the game', status: 'accepted' })) as { ok: boolean; summary: string };
    expect(res).toMatchObject({ ok: true, pending_approval: true, approval_id: 'appr-9' });
    expect(res.summary).toMatch(/add it by hand/i);
  });

  it('ALLOW: the underlying write executes with the original args', async () => {
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', reason: 'ok' } });
    const { wrapped, inner } = wrapOne('add_grocery_item', 'parent');
    const res = (await wrapped.execute({ item: 'Milk' })) as { ok: boolean; wrote?: string };
    expect(res.ok).toBe(true);
    expect(res.wrote).toBe('add_grocery_item');
    expect(inner).toHaveBeenCalledWith({ item: 'Milk' });
  });

  it('READ tools pass through untouched — no trust call, executes directly', async () => {
    const { wrapped, inner } = wrapOne('list_upcoming_events', 'child');
    const res = (await wrapped.execute({})) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(evaluateTrust).not.toHaveBeenCalled();
  });

  it('SWITCHED OFF: the family setting stops a chat write before the engine is asked', async () => {
    // "Switch Bubaly off" used to stop lib/ai/tools/execute.ts and the routine
    // cron, and leave chat creating events, chores and announcements — the one
    // surface a family would test the switch on.
    const off = supabaseWith({ ...AI_ON, enabled: false });
    const { wrapped, inner } = wrapOne('create_calendar_event', 'parent', off);
    const res = (await wrapped.execute({ title: 'Soccer' })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/switched off/i);
    expect(inner).not.toHaveBeenCalled();
    expect(evaluateTrust).not.toHaveBeenCalled();
  });

  it('RECOMMEND: the autonomy dial reaches chat, and a low-risk write is refused', async () => {
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', reason: 'role default', basis: 'role_default' } });
    const recommend = supabaseWith({ ...AI_ON, behavior: 'recommend' });
    const { wrapped, inner } = wrapOne('add_todo', 'parent', recommend);
    const res = (await wrapped.execute({ task: 'Bins' })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/recommend only/i);
    expect(inner).not.toHaveBeenCalled();
  });

  it('PREPARE: the same write is staged for a person, and an approval is actually filed', async () => {
    evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', reason: 'role default', basis: 'role_default' } });
    const prepare = supabaseWith({ ...AI_ON, behavior: 'prepare' });
    const { wrapped, inner } = wrapOne('add_todo', 'parent', prepare);
    const res = (await wrapped.execute({ task: 'Bins' })) as { ok: boolean; pending_approval?: boolean };
    expect(res).toMatchObject({ ok: true, pending_approval: true, approval_id: 'appr-1' });
    expect(inner).not.toHaveBeenCalled();
    // "Sent for parent approval" has to name something a parent can find.
    expect(openedApprovals).toHaveBeenCalledOnce();
  });

  it('every declared write-tool domain is a real mutating assistant tool (no typo bypass)', () => {
    // Guard against a write tool being renamed in tools.ts but left mapped here
    // (or vice-versa) — the mapping is the entire enforcement surface.
    const mapped = mappedToolNames();
    const toolsSrc = readSrc('lib/assistant/tools.ts');
    expect(mapped.length).toBeGreaterThanOrEqual(11);
    for (const name of mapped) {
      expect(toolsSrc, `mapped tool ${name} not found in tools.ts`).toContain(`name: '${name}'`);
    }
  });

  it('every mutating assistant tool is declared in TOOL_DOMAIN (no ungated write)', () => {
    // The direction that actually matters. The test above walks map → tools, so
    // it passes happily while a brand-new write tool sits in tools.ts with no
    // entry here — `wrapToolsWithTrust` returns an unmapped tool UNWRAPPED, and
    // it writes with no trust check at all. `complete_reminder` and
    // `snooze_reminder` shipped that way. This walks tools → map instead.
    const mapped = new Set(mappedToolNames());
    const mutating = mutatingToolNames();
    // Sanity: the scan must actually find the known writers, or an off-by-one
    // in the parser would make this assertion vacuous.
    expect(mutating).toContain('create_calendar_event');
    expect(mutating).toContain('complete_reminder');
    const ungated = mutating.filter((name) => !mapped.has(name));
    expect(ungated, `these assistant tools write to the database with no trust check: ${ungated.join(', ')}`).toEqual([]);
  });
});

// ─── Source scanners shared by the two guard tests ──────────────────────────

function readSrc(path: string): string {
  return String(require('node:fs').readFileSync(path, 'utf8'));
}

/** The tool names declared in trust-wrapper's TOOL_DOMAIN map. */
function mappedToolNames(): string[] {
  const block = readSrc('lib/assistant/trust-wrapper.ts').match(/const TOOL_DOMAIN:[^{]*\{([\s\S]*?)^\};/m);
  expect(block, 'TOOL_DOMAIN map not found in trust-wrapper.ts').toBeTruthy();
  return [...block![1].matchAll(/^\s*([a-z_]+):\s*'[a-z_]+',/gm)].map((m) => m[1]);
}

/**
 * Every tool in lib/assistant/tools.ts whose own body mutates the database.
 *
 * Each tool's slice runs from its `name:` line to the next one, so a helper
 * defined above the tool list (which may legitimately insert) is not attributed
 * to the first tool.
 */
function mutatingToolNames(): string[] {
  const src = readSrc('lib/assistant/tools.ts');
  const decls = [...src.matchAll(/^\s*name: '([a-z_]+)',$/gm)];
  const names: string[] = [];
  for (let i = 0; i < decls.length; i += 1) {
    const start = decls[i].index ?? 0;
    const end = i + 1 < decls.length ? (decls[i + 1].index ?? src.length) : src.length;
    const body = src.slice(start, end);
    if (/\.(insert|update|upsert|delete)\(/.test(body)) names.push(decls[i][1]);
  }
  return names;
}
