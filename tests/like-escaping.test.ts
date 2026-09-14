import { describe, expect, it } from 'vitest';
import { escapeLike } from '@/lib/db/like';

// The escaped forms below were checked against Postgres 16 directly, not just
// asserted here:
//   'victim@bigcorp.test' ilike '%'                -> t     ilike E'\\%'  -> f
//   'john@outlook.test'   ilike 'j_hn@outlook.test'-> t     escaped       -> f
//   'j_hn@outlook.test'   ilike E'j\\_hn@outlook.test'      -> t  (real _ still matches)
//   'ab'                  ilike E'a\\b'            -> t  (bare backslash swallows 'b')
describe('escapeLike', () => {
  it('neutralises the wildcards', () => {
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('_')).toBe('\\_');
    expect(escapeLike('j_hn@outlook.test')).toBe('j\\_hn@outlook.test');
    expect(escapeLike('%@%')).toBe('\\%@\\%');
  });

  it('escapes the backslash, and escapes it first', () => {
    // The repository's four local copies escape only % and _, so a value with a
    // backslash still swallows the next character inside LIKE.
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    // Escaping the backslash after the wildcards would double-escape the
    // backslashes this function just added and break the wildcard escape.
    expect(escapeLike('a\\%b')).toBe('a\\\\\\%b');
  });

  it('leaves an ordinary address untouched', () => {
    expect(escapeLike('victim@bigcorp.test')).toBe('victim@bigcorp.test');
    expect(escapeLike('first.last+tag@example.co.uk')).toBe('first.last+tag@example.co.uk');
  });

  it('is a no-op on the empty string', () => {
    expect(escapeLike('')).toBe('');
  });
});
