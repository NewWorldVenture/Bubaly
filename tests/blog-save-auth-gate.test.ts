import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// The blog heart is a signed-in feature (per the product requirement). These
// guards lock the contract so a refactor can't silently make saves anonymous
// again.
describe('blog save is gated behind sign-in', () => {
  const route = read('app/api/blog/save/route.ts');
  const button = read('components/blog/heart-button.tsx');
  const migration = read('supabase/migrations/0227_blog_post_saves.sql');

  it('POST /api/blog/save requires an authenticated user (401 before any write)', () => {
    // getUser() must be consulted and a 401 returned before the insert.
    expect(route).toMatch(/auth\.getUser\(\)/);
    const idx401 = route.indexOf('auth_required');
    const idxInsert = route.indexOf(".insert({ post_id: postId, user_id: userId })");
    expect(idx401).toBeGreaterThan(0);
    expect(idxInsert).toBeGreaterThan(idx401); // the auth gate comes first
    expect(route).toMatch(/status:\s*401/);
  });

  it('writes are keyed to the authenticated user id, not an anonymous visitor', () => {
    expect(route).toMatch(/user_id:\s*userId/);
    expect(route).not.toMatch(/visitor_id/);
  });

  it('the heart button sends signed-out readers to /login and back', () => {
    expect(button).toMatch(/\/login\?redirect=/);
    expect(button).toMatch(/authed === false/);
    // a 401 from the server also routes to sign in
    expect(button).toMatch(/res\.status === 401/);
  });

  it('blog_post_saves RLS restricts rows to their owner', () => {
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/user_id = auth\.uid\(\)/);
    expect(migration).toMatch(/FOR INSERT[\s\S]*WITH CHECK \(user_id = auth\.uid\(\)\)/);
    expect(migration).toMatch(/TO authenticated/);
  });
});
