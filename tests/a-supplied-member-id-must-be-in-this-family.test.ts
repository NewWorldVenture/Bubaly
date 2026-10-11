// A member id the model supplies is untrusted input, exactly like a name.
//
// `resolveAssigneeId` used to hand back any `assignee_id` unchanged, and the
// foreign keys it lands in (vacation_documents.member_id, todo assignees, ...)
// accept ANY household's family_members.id. So `documents.linkToVacation` with
// a prompt-injected member_id stored another household's member as the owner
// of this family's passport on the trip readiness card. The id is now checked
// against the family, in the resolver and again in the service.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { resolveAssigneeId } from '@/lib/ai/tools/family';
import { documentTools } from '@/lib/ai/tools/documents';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn(async () => undefined) }));

const linkTool = documentTools.find((tool) => tool.name === 'documents.linkToVacation')!;

function setup() {
  const db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('family_members', [
    { id: 'ours', family_id: 'fam-1', display_name: 'Ava', role: 'child', is_active: true },
    { id: 'theirs', family_id: 'fam-2', display_name: 'Zoe', role: 'child', is_active: true },
  ]);
  db.seed('documents', [{ id: 'd-1', family_id: 'fam-1', title: 'Ava passport', category: 'passport', is_secure: false, member_id: 'ours', expires_at: null, storage_path: 'fam-1/p.pdf' }]);
  db.seed('vacations', [{ id: 'v-1', family_id: 'fam-1', title: 'Paris' }]);
  const scope: ServiceScope = { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'm-parent', role: 'parent', actorKind: 'ai', tz: 'UTC', now: new Date('2026-10-10T12:00:00Z') };
  return { db, scope };
}

describe('resolveAssigneeId', () => {
  it('accepts an id in this family', async () => {
    const { scope } = setup();
    expect(await resolveAssigneeId(scope, { assignee_id: 'ours' })).toEqual({ ok: true, data: 'ours' });
  });

  it("refuses another household's member id, and an id that matches nobody", async () => {
    const { scope } = setup();
    expect(await resolveAssigneeId(scope, { assignee_id: 'theirs' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await resolveAssigneeId(scope, { assignee_id: 'nobody' })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('documents.linkToVacation with a supplied member_id', () => {
  it("does not store another household's member as the document's owner", async () => {
    const { db, scope } = setup();
    const res = await linkTool.execute(scope, linkTool.input.parse({ document_id: 'd-1', vacation_id: 'v-1', member_id: 'theirs' }));
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.table('vacation_documents')).toHaveLength(0);
  });

  it('stores a member of this family', async () => {
    const { db, scope } = setup();
    const res = await linkTool.execute(scope, linkTool.input.parse({ document_id: 'd-1', vacation_id: 'v-1', member_id: 'ours' }));
    expect(res).toMatchObject({ ok: true });
    expect(db.table('vacation_documents')).toEqual([expect.objectContaining({ member_id: 'ours', family_id: 'fam-1' })]);
  });
});
