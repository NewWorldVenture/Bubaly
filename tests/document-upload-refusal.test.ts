import { describe, expect, it, vi } from 'vitest';
import { decideUpload, performUpload, type UploadEffects } from '@/lib/documents/upload';

// The Vault refusal, executed rather than read.
//
// The regression this guards was not "the rule is wrong" — it was "the rule ran
// too late". `is_secure: view === 'vault' && manager` filed a non-manager's
// Vault upload as Shared, visible to the whole family, under a success toast,
// and the bytes were already in the bucket by the time the classification was
// decided. An assertion over the source text cannot tell those two orderings
// apart; spies can.

function effects(overrides: Partial<UploadEffects> = {}) {
  const store = vi.fn(async () => ({ path: 'family-1/legal/passport.pdf', error: null }));
  const record = vi.fn(async () => ({ error: null as string | null }));
  const discard = vi.fn(async () => {});
  return { store, record, discard, ...overrides } as UploadEffects & {
    store: typeof store; record: typeof record; discard: typeof discard;
  };
}

describe('a refused upload performs no effect at all', () => {
  it('a non-manager uploading to the Secure Vault stores nothing and records nothing', async () => {
    const fx = effects();
    const outcome = await performUpload(
      { view: 'vault', category: '', manager: false, folderFallback: 'vault' }, fx,
    );

    expect(outcome).toEqual({
      ok: false,
      reason: 'Only a parent or another adult can add a file to the Secure Vault. Ask one of them, or upload it to Shared Files instead.',
    });
    expect(fx.store, 'the bytes must not reach the bucket').not.toHaveBeenCalled();
    expect(fx.record, 'no documents row may be written').not.toHaveBeenCalled();
    expect(fx.discard).not.toHaveBeenCalled();
  });

  it.each(['legal', 'Medical', ' passport ', 'INSURANCE', 'tax'])(
    'a non-manager filing a %s document is refused before either effect',
    async (category) => {
      const fx = effects();
      // Note the view: Shared Files, not the Vault. Re-labelling a medical
      // record and filing it somewhere ordinary is the obvious way around a
      // flag-only rule, which is why 0266's SQL predicate reads the category.
      const outcome = await performUpload(
        { view: 'shared', category, manager: false, folderFallback: 'shared' }, fx,
      );

      expect(outcome.ok).toBe(false);
      expect(fx.store).not.toHaveBeenCalled();
      expect(fx.record).not.toHaveBeenCalled();
    },
  );

  it('names the category back in the sentence, so the person knows which rule they hit', async () => {
    const outcome = await performUpload(
      { view: 'cloud', category: 'Medical', manager: false, folderFallback: 'cloud' }, effects(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('Only a parent or another adult can file a medical document. Ask one of them to add it.');
  });
});

describe('an allowed upload honours the destination it was asked for', () => {
  it('a manager uploading to the Vault records is_secure true', async () => {
    const fx = effects();
    const outcome = await performUpload(
      { view: 'vault', category: 'passport', manager: true, folderFallback: 'vault' }, fx,
    );

    expect(outcome).toEqual({ ok: true, storagePath: 'family-1/legal/passport.pdf', isSecure: true });
    expect(fx.store).toHaveBeenCalledWith('passport');
    expect(fx.record).toHaveBeenCalledWith({ storagePath: 'family-1/legal/passport.pdf', isSecure: true });
    expect(fx.discard).not.toHaveBeenCalled();
  });

  it('never quietly downgrades a Vault upload to Shared', async () => {
    // The exact shape of the original bug: the only two outcomes for a Vault
    // submission are a secure row or a refusal. There is no third.
    for (const manager of [true, false]) {
      const fx = effects();
      const outcome = await performUpload(
        { view: 'vault', category: '', manager, folderFallback: 'vault' }, fx,
      );
      if (outcome.ok) expect(outcome.isSecure).toBe(true);
      else expect(fx.record).not.toHaveBeenCalled();
    }
  });

  it('a non-manager may still file an ordinary document, and it is not secure', async () => {
    const fx = effects();
    const outcome = await performUpload(
      { view: 'shared', category: 'school', manager: false, folderFallback: 'shared' }, fx,
    );

    expect(outcome).toMatchObject({ ok: true, isSecure: false });
    expect(fx.record).toHaveBeenCalledWith({ storagePath: 'family-1/legal/passport.pdf', isSecure: false });
  });

  it('falls back to the view folder when no category is typed', async () => {
    const fx = effects();
    await performUpload({ view: 'cloud', category: '   ', manager: true, folderFallback: 'cloud' }, fx);
    expect(fx.store).toHaveBeenCalledWith('cloud');
  });
});

describe('a stored object never outlives a failed row', () => {
  it('discards the upload when the insert is rejected, and reports the reason', async () => {
    const fx = effects({ record: vi.fn(async () => ({ error: 'new row violates row-level security policy' })) });
    const outcome = await performUpload(
      { view: 'vault', category: 'legal', manager: true, folderFallback: 'vault' }, fx,
    );

    expect(outcome).toEqual({ ok: false, reason: 'new row violates row-level security policy' });
    // 0266 can reject an insert the client did not anticipate. Leaving the
    // object behind would consume the family's storage with a file the app
    // cannot show them.
    expect(fx.discard).toHaveBeenCalledWith('family-1/legal/passport.pdf');
  });

  it('does not try to discard anything when the store itself failed', async () => {
    const fx = effects({ store: vi.fn(async () => ({ path: null, error: 'Network error' })) });
    const outcome = await performUpload(
      { view: 'shared', category: '', manager: true, folderFallback: 'shared' }, fx,
    );

    expect(outcome).toEqual({ ok: false, reason: 'Network error' });
    expect(fx.record).not.toHaveBeenCalled();
    expect(fx.discard).not.toHaveBeenCalled();
  });
});

describe('decideUpload on its own', () => {
  it('lets a manager do everything, and marks only the Vault secure', () => {
    expect(decideUpload({ view: 'vault', category: 'medical', manager: true })).toEqual({ allowed: true, isSecure: true });
    expect(decideUpload({ view: 'cloud', category: 'medical', manager: true })).toEqual({ allowed: true, isSecure: false });
    expect(decideUpload({ view: 'shared', category: '', manager: true })).toEqual({ allowed: true, isSecure: false });
  });

  it('refuses the Vault before it looks at the category', () => {
    // Both rules fire for a non-manager putting a passport in the Vault; the
    // Vault sentence is the more useful one because it offers the alternative.
    const decision = decideUpload({ view: 'vault', category: 'passport', manager: false });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('Secure Vault');
  });
});
