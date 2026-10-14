import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_HANDOFF_PARAM, ASSISTANT_HANDOFF_TTL_MS, buildAssistantUrl, clearAssistantHandoff, parsePrefillQuery, readAssistantHandoff, stageAssistantHandoff,
} from '@/lib/ai/prefill';

describe('parsePrefillQuery', () => {
  it('extracts a q value with or without a leading ?', () => {
    expect(parsePrefillQuery('?q=plan%20dinner')).toBe('plan dinner');
    expect(parsePrefillQuery('q=hello')).toBe('hello');
  });

  it('returns null for absent or blank q', () => {
    expect(parsePrefillQuery('')).toBeNull();
    expect(parsePrefillQuery('?foo=bar')).toBeNull();
    expect(parsePrefillQuery('?q=')).toBeNull();
    expect(parsePrefillQuery('?q=%20%20')).toBeNull();
  });

  it('trims and caps length', () => {
    expect(parsePrefillQuery('?q=' + encodeURIComponent('  spaced  '))).toBe('spaced');
    expect(parsePrefillQuery('?q=' + 'a'.repeat(2000), 100)).toHaveLength(100);
  });
});

describe('buildAssistantUrl', () => {
  it('encodes the question and round-trips through parsePrefillQuery', () => {
    const url = buildAssistantUrl('plan dinner & lunch?');
    const search = url.slice(url.indexOf('?'));
    expect(parsePrefillQuery(search)).toBe('plan dinner & lunch?');
  });
  it('returns the bare base for blank input', () => {
    expect(buildAssistantUrl('   ')).toBe('/dashboard/assistant');
    expect(buildAssistantUrl('hi', '/x')).toBe('/x?q=hi');
  });
});

// N6: only the app's own hand-off is sent on arrival. It lives in this tab's
// sessionStorage under a one-time nonce; a link from outside can carry a nonce
// but cannot write the storage, so it cannot make anything send.
describe('the in-app assistant hand-off', () => {
  function memoryStorage() {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
    };
  }

  it('stages the question under a nonce that only the URL it returns carries', () => {
    const storage = memoryStorage();
    const url = stageAssistantHandoff('  plan our week  ', { storage, nonce: 'n-1', now: 1_000 });
    expect(url).toBe(`/dashboard/assistant?${ASSISTANT_HANDOFF_PARAM}=n-1`);
    expect(url).not.toContain('plan');
    expect(readAssistantHandoff(storage, url.slice(url.indexOf('?')), 1_500)).toBe('plan our week');
  });

  it('reads nothing for a guessed nonce, a missing one, a stale one or another tab’s storage', () => {
    const storage = memoryStorage();
    stageAssistantHandoff('plan our week', { storage, nonce: 'n-1', now: 1_000 });
    expect(readAssistantHandoff(storage, '?handoff=guess', 1_500)).toBeNull();
    expect(readAssistantHandoff(storage, '?q=plan%20our%20week', 1_500)).toBeNull();
    expect(readAssistantHandoff(storage, '?handoff=n-1', 1_000 + ASSISTANT_HANDOFF_TTL_MS + 1)).toBeNull();
    expect(readAssistantHandoff(memoryStorage(), '?handoff=n-1', 1_500)).toBeNull();
  });

  it('is sent once: clearing it leaves nothing to read', () => {
    const storage = memoryStorage();
    stageAssistantHandoff('plan our week', { storage, nonce: 'n-1', now: 1_000 });
    clearAssistantHandoff(storage);
    expect(readAssistantHandoff(storage, '?handoff=n-1', 1_500)).toBeNull();
  });

  it('falls back to a draft-only link when storage is unavailable', () => {
    const denied = { getItem: () => null, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(stageAssistantHandoff('plan our week', { storage: denied })).toBe('/dashboard/assistant?q=plan%20our%20week');
    expect(stageAssistantHandoff('   ', { storage: memoryStorage() })).toBe('/dashboard/assistant');
  });
});
