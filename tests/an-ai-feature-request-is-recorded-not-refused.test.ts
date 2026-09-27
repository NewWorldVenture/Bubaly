// P-10 (2026-09-27 page audit). 0255 lets a member insert an `ai_requests` row
// of kind `concierge` and no other; "feature, routine, trigger and handle_it
// requests are filed by server code". But `createRequest` filed every kind on
// the caller's client, so every `withAiRequest` surface — the assistant, the
// brief, the habit and relationship coaches — had its `feature` row refused by
// RLS. On a local stack with every migration, a crawl that used them all left
// 13 concierge rows and not one feature row, and the Free plan's monthly AI
// allowance, which counts these rows, never counted an assistant turn.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';

type Insert = { client: string; row: Record<string, unknown> };
const inserts: Insert[] = [];

function fakeClient(name: string) {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push({ client: name, row });
        return { select: () => ({ single: async () => ({ data: { id: `${name}-row` }, error: null }) }) };
      },
    }),
  };
}

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fakeClient('service') }));

const { createRequest } = await import('@/lib/ai/runs/store');

const member = { db: fakeClient('member'), familyId: 'fam-1', userId: 'u1', memberId: 'm1', role: 'parent', actorKind: 'member' } as unknown as ServiceScope;

describe('who files an AI request', () => {
  beforeEach(() => { inserts.length = 0; });

  it('files a feature request on the ledger client, for the verified family and person', async () => {
    const res = await createRequest(member, { requestText: 'brief me', kind: 'feature', feature: 'briefing.morning' });
    expect(res).toEqual({ ok: true, data: { id: 'service-row' } });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].client).toBe('service');
    expect(inserts[0].row).toMatchObject({ family_id: 'fam-1', requested_by: 'u1', requested_by_member_id: 'm1', kind: 'feature', status: 'queued' });
  });

  it('keeps a concierge request on the person\'s own client, where RLS checks it (control)', async () => {
    await createRequest(member, { requestText: 'plan our week', kind: 'concierge' });
    expect(inserts.map((i) => i.client)).toEqual(['member']);
  });

  it('treats an unknown kind as the concierge, on the person\'s client', async () => {
    await createRequest(member, { requestText: 'x', kind: 'made-up' });
    expect(inserts).toEqual([expect.objectContaining({ client: 'member', row: expect.objectContaining({ kind: 'concierge' }) })]);
  });

  it('uses the client a caller hands it (the cron, the executor)', async () => {
    await createRequest(member, { requestText: 'weekly', kind: 'routine' }, { db: fakeClient('cron') as never });
    expect(inserts.map((i) => i.client)).toEqual(['cron']);
  });

  it('matches the policy it has to satisfy: a member may insert the concierge kind only', () => {
    const sql = readFileSync('supabase/migrations/0255_ai_runtime_lockdown.sql', 'utf8');
    expect(sql).toMatch(/create policy ai_requests_insert[\s\S]*?and kind = 'concierge'/);
  });
});
