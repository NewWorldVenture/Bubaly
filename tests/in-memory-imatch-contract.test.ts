import { describe, expect, it } from 'vitest';
import { literalCaseInsensitivePattern, literalContainsPattern } from '@/lib/supabase/escape-like';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// These ASCII vectors are the same literal inputs exercised by the native
// PostgREST CRM contract. This model does not implement arbitrary PostgreSQL ARE.
describe('the in-memory imatch model preserves native literal email identity', () => {
  it.each(['p%q', 'p_q', 'p\\q', 'p*q', 'p^$.*+?()[]{}|\\q'])('selects only %s among 501 neighbours', async (local) => {
    const db = createInMemorySupabase();
    const email = `${local}@example.com`;
    db.seed('contacts', [
      ...Array.from({ length: 501 }, (_, index) => ({ id: `neighbour-${index}`, email: `${local}x${index}@example.com`, owner: 'foreign' })),
      { id: 'correct', email: email.toUpperCase(), owner: null },
    ]);
    const result = await db.from('contacts').select('id,email').filter('email', 'imatch', literalCaseInsensitivePattern(email));
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: 'correct', email: email.toUpperCase() }]);
    const update = await db.from('contacts').update({ owner: 'actor' }).filter('email', 'imatch', literalCaseInsensitivePattern(email)).is('owner', null).select('id');
    expect(update.error).toBeNull();
    expect(update.data).toEqual([{ id: 'correct' }]);
    expect(db.table('contacts').filter(row => row.owner === 'foreign')).toHaveLength(501);
  });

  it('keeps literal star distinct from percent and requires the complete address', async () => {
    const db = createInMemorySupabase();
    db.seed('contacts', [
      { id: 'star', email: 'p*q@example.com' }, { id: 'percent', email: 'p%q@example.com' },
      { id: 'prefix', email: 'xp*q@example.com' }, { id: 'suffix', email: 'p*q@example.comx' },
      { id: 'null', email: null }, { id: 'number', email: 42 },
    ]);
    const result = await db.from('contacts').select('id').filter('email', 'imatch', literalCaseInsensitivePattern('p*q@example.com'));
    expect(result.data).toEqual([{ id: 'star' }]);
    expect((await db.from('contacts').select('id').filter('email', 'imatch', literalCaseInsensitivePattern('missing@example.com'))).data).toEqual([]);
  });

  // Unanchored, an escaped literal is "contains" in PostgreSQL's ARE, as the
  // completed-task search sends it (literalContainsPattern).
  it('an unanchored escaped literal is contained, star kept distinct from percent', async () => {
    const db = createInMemorySupabase();
    db.seed('tasks', [
      { id: 'star', title: 'Math* worksheet' }, { id: 'percent', title: 'Math% worksheet' },
      { id: 'plain', title: 'Math worksheet' }, { id: 'null', title: null },
    ]);
    expect((await db.from('tasks').select('id').filter('title', 'imatch', literalContainsPattern('math*'))).data).toEqual([{ id: 'star' }]);
    expect((await db.from('tasks').select('id').filter('title', 'imatch', literalContainsPattern('*'))).data).toEqual([{ id: 'star' }]);
    expect((await db.from('tasks').select('id').filter('title', 'imatch', literalContainsPattern('WORKSHEET'))).data).toEqual([{ id: 'star' }, { id: 'percent' }, { id: 'plain' }]);
  });

  it.each(['a.*b', 'a|b', '[ab]', 'a\\d', '^a', 'a$', '^a.*$', '^a|b$', '^[ab]$', '^a\\d$', '^a\\$'])('refuses unsupported ARE syntax %s', pattern => {
    const db = createInMemorySupabase();
    expect(() => db.from('contacts').select('id').filter('email', 'imatch', pattern)).toThrow('unsupported imatch pattern');
  });

  it('preserves JSON-path filters and independent owner CAS narrowing', async () => {
    const db = createInMemorySupabase();
    db.seed('contacts', [
      { id: 'owned', email: 'same@example.com', owner: 'other', metadata: { alias: 'same@example.com' } },
      { id: 'free', email: 'same@example.com', owner: null, metadata: { alias: 'different@example.com' } },
    ]);
    expect((await db.from('contacts').select('id').filter('metadata->>alias', 'imatch', literalCaseInsensitivePattern('same@example.com'))).data).toEqual([{ id: 'owned' }]);
    expect((await db.from('contacts').update({ owner: 'actor' }).filter('email', 'imatch', literalCaseInsensitivePattern('same@example.com')).is('owner', null).select('id')).data).toEqual([{ id: 'free' }]);
    expect(db.table('contacts').find(row => row.id === 'owned')?.owner).toBe('other');
  });
});
