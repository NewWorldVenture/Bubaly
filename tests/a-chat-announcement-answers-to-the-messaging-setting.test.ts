// Chat's `create_announcement` was gated under the domain 'announcements' —
// not a trust domain, so no setting and no policy could ever name it. The
// registry tool it aliases, `messages.createAnnouncement`, is 'messaging'. So a
// household that set Settings → Bubaly AI → Messaging to "suggest only", or
// wrote a trust policy denying Bubaly in messaging, still had a family-wide
// announcement posted for it from chat: the dial fell back to the global
// "execute" and the policy never matched.
//
// Driven as POST /api/ai/chat builds it — the real toolbox, the real trust
// wrapper, the real gate and trust engine — over an in-memory household.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { buildAssistantTools } from '@/lib/assistant/tools';
import { TOOL_DOMAIN, wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import { getTool } from '@/lib/ai/tools/registry';

const FAMILY = 'fam-1';
const PARENT = { userId: 'user-parent', memberId: 'mem-parent' };
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const SETTINGS = { family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true };

async function postAnnouncementAsParent(): Promise<{ ok: boolean; error?: string; pending_approval?: boolean }> {
  const ctx = { familyId: FAMILY, userId: PARENT.userId, memberId: PARENT.memberId, role: 'parent', members: [{ id: PARENT.memberId, display_name: 'Dan' }], tz: 'UTC' };
  const tools = wrapToolsWithTrust(buildAssistantTools(db, ctx), db, FAMILY, 'parent', PARENT.memberId);
  const tool = tools.find((t) => t.name === 'create_announcement');
  if (!tool) throw new Error('create_announcement is not in the toolbox');
  return await tool.execute({ title: 'Movie night Friday' }) as { ok: boolean; error?: string; pending_approval?: boolean };
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: { approval_requests: { status: 'pending', approvals: [], edited_payload: null, plan_step_ids: [] } },
  }) as DB;
  holder.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: PARENT.memberId, family_id: FAMILY, user_id: PARENT.userId, role: 'parent', is_active: true, display_name: 'Dan' }]);
});

describe("chat's announcements answer to the family's messaging setting", () => {
  it('Messaging on "suggest only" stops the post, though the global dial says execute', async () => {
    db.seed('family_ai_settings', [{ ...SETTINGS, category_behavior: { messaging: 'recommend' } }]);
    const res = await postAnnouncementAsParent();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/recommend only/i);
    expect(db.table('family_announcements')).toEqual([]);
  });

  it('Messaging on "prepare" sends the post to a parent instead of publishing it', async () => {
    db.seed('family_ai_settings', [{ ...SETTINGS, category_behavior: { messaging: 'prepare' } }]);
    const res = await postAnnouncementAsParent();
    expect(res).toMatchObject({ ok: true, pending_approval: true });
    expect(db.table('family_announcements')).toEqual([]);
    expect(db.table('approval_requests').map((r) => r.domain)).toEqual(['messaging']);
  });

  it('a trust policy denying Bubaly in messaging binds the chat post', async () => {
    db.seed('family_ai_settings', [SETTINGS]);
    db.seed('trust_policies', [{
      id: 'p-msg', family_id: FAMILY, name: 'Bubaly · messaging · automate → deny', domain: 'messaging', capability: 'automate',
      subject_kind: 'ai', effect: 'deny', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100, enabled: true,
    }]);
    const res = await postAnnouncementAsParent();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked by household policy/i);
    expect(db.table('family_announcements')).toEqual([]);
  });

  it('with nothing set, a parent still posts the announcement', async () => {
    db.seed('family_ai_settings', [SETTINGS]);
    const res = await postAnnouncementAsParent();
    expect(res.ok, res.error).toBe(true);
    expect(db.table('family_announcements').map((r) => r.title)).toEqual(['Movie night Friday']);
  });

  it('every gated toolbox write is gated under the domain of the registry tool it aliases', () => {
    for (const [name, declared] of Object.entries(TOOL_DOMAIN)) {
      const registry = getTool(name);
      expect(registry, `${name} no longer resolves in the registry`).not.toBeNull();
      expect(declared, `${name} is mapped to '${declared}' but ${registry!.name} is '${registry!.domain}'`).toBe(registry!.domain);
    }
  });
});
