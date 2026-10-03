// P-10 (2026-09-27 page audit). 0255 lets a member insert an `ai_requests` row
// of kind `concierge` and no other; "feature, routine, trigger and handle_it
// requests are filed by server code". But `createRequest` filed every kind on
// the caller's client, so every `withAiRequest` surface — the assistant, the
// brief, the habit and relationship coaches — had its `feature` row refused by
// RLS. On a local stack with every migration, a crawl that used them all left
// 13 concierge rows and not one feature row, and the Free plan's monthly AI
// allowance, which counts these rows, never counted an assistant turn.
//
// #892 review 4174949251 then closed the concierge exception too: 0255's member
// INSERT policy let a member file rows the F19 meter counts through the Data API,
// outside 0477's admission lock and free to say `metered = false`. 0477 withdraws
// INSERT from `authenticated`, so EVERY kind is filed on the ledger client, for
// the family and person of the verified scope.
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

  it('files a concierge request on the ledger client too, never the person\'s own (0477 withdraws member INSERT)', async () => {
    await createRequest(member, { requestText: 'plan our week', kind: 'concierge' });
    expect(inserts).toEqual([expect.objectContaining({ client: 'service', row: expect.objectContaining({ kind: 'concierge', family_id: 'fam-1', requested_by: 'u1', requested_by_member_id: 'm1' }) })]);
  });

  it('treats an unknown kind as the concierge, on the ledger client', async () => {
    await createRequest(member, { requestText: 'x', kind: 'made-up' });
    expect(inserts).toEqual([expect.objectContaining({ client: 'service', row: expect.objectContaining({ kind: 'concierge' }) })]);
  });

  it('uses the client a caller hands it (the cron, the executor)', async () => {
    await createRequest(member, { requestText: 'weekly', kind: 'routine' }, { db: fakeClient('cron') as never });
    expect(inserts.map((i) => i.client)).toEqual(['cron']);
  });

  it('matches the schema it has to satisfy: no client role inserts a request row (0477)', () => {
    const sql = readFileSync('supabase/migrations/0477_ai_requests_admission_is_atomic.sql', 'utf8');
    expect(sql).toMatch(/drop policy if exists ai_requests_insert on public\.ai_requests;/);
    expect(sql).toMatch(/revoke insert on public\.ai_requests from anon, authenticated;/);
  });
});
