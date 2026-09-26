import { describe, expect, it } from 'vitest';
import { preservePendingPkceVerifier } from '@/lib/auth/session';

const origin = 'https://owned-project.supabase.co';
const key = 'sb-owned-project-auth-token-code-verifier';
const remove = (name: string) => ({ name, value: '', options: { maxAge: 0, path: '/' } });
const write = (name: string, value: string) => ({ name, value, options: { maxAge: 3600, path: '/' } });

describe('ordinary session writes do not own a pending verifier', () => {
  it('retains the new session and old session-chunk cleanup while refusing only verifier cleanup', () => {
    const session = write('sb-owned-project-auth-token', 'rotated-session');
    const oldSessionChunk = remove('sb-owned-project-auth-token.0');
    const cookies = [remove(key), session, remove(`${key}.0`), oldSessionChunk, remove(`${key}.12`)];
    const before = structuredClone(cookies);

    expect(preservePendingPkceVerifier(cookies, origin)).toEqual([session, oldSessionChunk]);
    expect(cookies).toEqual(before);
  });

  it('does not intercept another project or similarly named application cookies', () => {
    const unrelated = [
      remove('sb-other-project-auth-token-code-verifier'),
      remove('sb-other-project-auth-token-code-verifier.0'),
      remove(`${key}-backup`), remove(`${key}.later`), remove(`${key}.0.extra`),
    ];
    expect(preservePendingPkceVerifier([remove(key), ...unrelated], origin)).toEqual(unrelated);
  });

  it('an unrelated project initiation cannot authorize deletion of this pending handoff', () => {
    const otherInitiation = write('sb-other-project-auth-token-code-verifier', 'new-other-verifier');
    expect(preservePendingPkceVerifier([remove(key), otherInitiation, remove(`${key}.1`)], origin)).toEqual([otherInitiation]);
  });

  it('a new unchunked initiation can replace the previous chunked verifier without leaving stale chunks', () => {
    const replacement = [remove(`${key}.0`), remove(`${key}.1`), write(key, 'new-verifier')];
    expect(preservePendingPkceVerifier(replacement, origin)).toEqual(replacement);
  });

  it('a new chunked initiation can replace the previous unchunked verifier', () => {
    const replacement = [remove(key), write(`${key}.0`, 'new-part-one'), write(`${key}.1`, 'new-part-two')];
    expect(preservePendingPkceVerifier(replacement, origin)).toEqual(replacement);
  });
});
