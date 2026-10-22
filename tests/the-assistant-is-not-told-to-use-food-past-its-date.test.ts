// The assistant's shopping context does not call expired food "Use soon".
//
// `pantryList().expiring` keeps expired rows on purpose — the pantry screen
// labels them "Expired 3d ago". The context slice rendered every one of them
// as "Use soon: chicken breast (by Oct 1)", so on Oct 13 the model was told to
// cook with chicken that went off twelve days earlier. Expired items are now a
// separate "check or discard" line.
//
// The real slice, loaded against an in-memory database.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { shoppingSlice } from '@/lib/ai/context/slices/shopping';
import type { SliceEnv } from '@/lib/ai/context/policy';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';

describe('the shopping context slice', () => {
  it('says "use soon" only about food still good, and names expired food as such', async () => {
    const db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
      pantry_items: { quantity: 1, unit: null, location: 'fridge', low_threshold: null, is_staple: false, category: null },
      grocery_lists: { is_archived: false, archived_at: null },
    } });
    db.seed('grocery_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Groceries', created_by: 'user-one' }]);
    db.seed('pantry_items', [
      { id: 'p-old', family_id: FAMILY, name: 'chicken breast', expires_at: '2026-10-01' },
      { id: 'p-new', family_id: FAMILY, name: 'spinach', expires_at: '2026-10-15' },
    ]);
    const scope: ServiceScope = {
      db, familyId: FAMILY, userId: 'user-one', memberId: 'member-one', role: 'parent',
      actorKind: 'ai', tz: 'America/Los_Angeles', now: new Date('2026-10-13T16:00:00Z'),
    };

    // What the context builder passes: the family's day is `todayKey`, in its zone.
    const env: SliceEnv = {
      now: scope.now!, tz: scope.tz, todayKey: '2026-10-13',
      weekFromIso: '2026-10-13T07:00:00.000Z', weekToIso: '2026-10-20T07:00:00.000Z',
      viewer: { role: 'parent', memberId: 'member-one', canManage: true }, members: [], pageContext: null,
    };
    const res = await shoppingSlice.load(scope, env);
    if (!res.ok) throw new Error(res.error);

    const useSoon = res.data.lines.find((line) => line.startsWith('- Use soon:')) ?? '';
    expect(useSoon).toContain('spinach');
    expect(useSoon).not.toContain('chicken breast');
    const expired = res.data.lines.find((line) => line.startsWith('- Past best-by')) ?? '';
    expect(expired).toContain('chicken breast');
    expect(expired).toContain('check or discard');
  });
});
