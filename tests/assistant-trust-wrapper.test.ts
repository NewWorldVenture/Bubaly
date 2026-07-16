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
vi.mock('@/lib/trust/server', () => ({
  evaluateTrust: (...args: unknown[]) => evaluateTrust(...args),
  // roleOf is pure; a faithful stub keeps the wrapper's actor role meaningful.
  roleOf: (r: string | null | undefined) => (r === 'parent' || r === 'adult' ? 'guardian' : 'member'),
}));

import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import type { ToolSpec } from '@/lib/ai/provider';

const fakeSupabase = {} as never;

function makeTool(name: string): { spec: ToolSpec; inner: ReturnType<typeof vi.fn> } {
  const inner = vi.fn(async (args: Record<string, unknown>) => ({ ok: true, wrote: name, args }));
  const spec: ToolSpec = { name, description: name, input_schema: {}, execute: inner };
  return { spec, inner };
}

function wrapOne(name: string, role: string | null = 'child') {
  const { spec, inner } = makeTool(name);
  const [wrapped] = wrapToolsWithTrust([spec], fakeSupabase, 'fam-1', role);
  return { wrapped, inner };
}

beforeEach(() => evaluateTrust.mockReset());

describe('A-15 wrapToolsWithTrust gates every write tool', () => {
  it('DENY: the underlying write never runs and the child is told it was blocked', async () => {
    evaluateTrust.mockResolvedValue({ decision: { effect: 'deny', reason: 'children cannot post announcements' } });
    const { wrapped, inner } = wrapOne('create_announcement', 'child');
    const res = (await wrapped.execute({ title: 'Party' })) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked by household policy/i);
    expect(inner).not.toHaveBeenCalled();
  });

  it('REQUIRE_APPROVAL: no write happens, returns a pending-approval chip', async () => {
    evaluateTrust.mockResolvedValue({ decision: { effect: 'require_approval', reason: 'needs a parent' }, approvalId: 'appr-1' });
    const { wrapped, inner } = wrapOne('add_chore', 'child');
    const res = (await wrapped.execute({ title: 'Mow lawn' })) as { ok: boolean; pendingApproval?: boolean };
    expect(res.ok).toBe(true);
    expect(res.pendingApproval).toBe(true);
    expect(inner).not.toHaveBeenCalled();
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

  it('every declared write-tool domain is a real mutating assistant tool (no typo bypass)', () => {
    // Guard against a write tool being renamed in tools.ts but left mapped here
    // (or vice-versa) — the mapping is the entire enforcement surface.
    const trustSrc = String(require('node:fs').readFileSync('lib/assistant/trust-wrapper.ts', 'utf8'));
    const toolsSrc = String(require('node:fs').readFileSync('lib/assistant/tools.ts', 'utf8'));
    const block = trustSrc.match(/const TOOL_DOMAIN:[^{]*\{([\s\S]*?)\};/);
    expect(block, 'TOOL_DOMAIN map not found in trust-wrapper.ts').toBeTruthy();
    const mapped = [...block![1].matchAll(/^\s*([a-z_]+):\s*'[a-z]+',/gm)].map((m) => m[1]);
    expect(mapped.length).toBeGreaterThanOrEqual(9);
    for (const name of mapped) {
      expect(toolsSrc, `mapped tool ${name} not found in tools.ts`).toContain(`name: '${name}'`);
    }
  });
});
