import { describe, expect, it } from 'vitest';
import { candidateLocals, MAX_CANDIDATES, provisionFamilyEmailLocal } from '@/lib/contact-center/provision';
import { isClaimableEmailLocal, isReservedEmailLocal } from '@/lib/contact-center/address';

// Every new family is given <local>@bubaly.com at the end of onboarding, so a
// teacher or a doctor's office has somewhere to send appointment mail. The two
// things that can go wrong are collisions (the SECOND Smith family) and the
// provisioning itself failing — and the second must never cost a family their
// completed onboarding, because the address is a bonus on top of a family that
// already exists.

describe('candidateLocals', () => {
  it('offers the readable name first', () => {
    expect(candidateLocals('The Smith Family')[0]).toBe('smith');
  });

  it('stays readable for the next several families of the same name', () => {
    const list = candidateLocals('The Smith Family');
    expect(list.slice(0, 4)).toEqual(['smith', 'smith2', 'smith3', 'smith4']);
    expect(list).toContain('smith-family');
  });

  it('never proposes a name that is not claimable', () => {
    for (const name of ['The Smith Family', 'Support', 'Admin', 'A', '', null, undefined, '???']) {
      for (const local of candidateLocals(name as string)) {
        expect(isClaimableEmailLocal(local), `${local} from ${name}`).toBe(true);
        expect(isReservedEmailLocal(local)).toBe(false);
      }
    }
  });

  it('is bounded and free of duplicates, so the caller always terminates', () => {
    const list = candidateLocals('The Smith Family');
    expect(list.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(new Set(list).size).toBe(list.length);
  });

  it('is deterministic for a family, so a retry proposes the same list', () => {
    expect(candidateLocals('Smith', 'fam-1')).toEqual(candidateLocals('Smith', 'fam-1'));
  });

  it('gives different families different tails', () => {
    const a = candidateLocals('Smith', 'fam-1');
    const b = candidateLocals('Smith', 'fam-2');
    expect(a).not.toEqual(b);
  });
});

/** A channel table whose `taken` set decides which updates hit the unique index. */
function db(opts: { existing?: string | null; taken?: Set<string>; failRead?: boolean; failWrite?: boolean } = {}) {
  const taken = opts.taken ?? new Set<string>();
  let assigned: string | null = opts.existing ?? null;
  const attempts: string[] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            opts.failRead ? { data: null, error: { message: 'unreachable' } } : { data: { email_local: assigned }, error: null },
        }),
      }),
      update: (patch: { email_local: string }) => ({
        eq: () => ({
          is: async () => {
            attempts.push(patch.email_local);
            if (opts.failWrite) return { error: { code: '500', message: 'boom' } };
            if (taken.has(patch.email_local)) return { error: { code: '23505', message: 'duplicate' } };
            assigned = patch.email_local;
            return { error: null };
          },
        }),
      }),
    }),
  };
  return { client: client as never, attempts, get assigned() { return assigned; } };
}

describe('provisionFamilyEmailLocal', () => {
  it('assigns the readable name when it is free', async () => {
    const t = db();
    const res = await provisionFamilyEmailLocal(t.client, 'fam-1', 'The Smith Family');
    expect(res).toEqual({ assigned: true, local: 'smith' });
  });

  it('walks past names already taken by other families', async () => {
    const t = db({ taken: new Set(['smith', 'smith2']) });
    const res = await provisionFamilyEmailLocal(t.client, 'fam-1', 'The Smith Family');
    expect(res).toEqual({ assigned: true, local: 'smith3' });
    expect(t.attempts.slice(0, 3)).toEqual(['smith', 'smith2', 'smith3']);
  });

  // The unique index is the arbiter, not a pre-check: two families finishing at
  // the same instant both see "smith" free and exactly one insert wins.
  it('treats a 23505 as "try the next name", not as an error', async () => {
    const t = db({ taken: new Set(['smith']) });
    const res = await provisionFamilyEmailLocal(t.client, 'fam-1', 'Smith');
    expect(res.assigned).toBe(true);
    expect(t.attempts[0]).toBe('smith');
  });

  it('never renames a family that already has an address', async () => {
    const t = db({ existing: 'smith' });
    const res = await provisionFamilyEmailLocal(t.client, 'fam-1', 'Different Name Entirely');
    expect(res).toEqual({ assigned: false, reason: 'already_assigned', local: 'smith' });
    expect(t.attempts).toEqual([]);
  });

  it('reports unavailable rather than throwing when the read fails', async () => {
    const t = db({ failRead: true });
    await expect(provisionFamilyEmailLocal(t.client, 'fam-1', 'Smith')).resolves.toEqual({ assigned: false, reason: 'unavailable' });
  });

  it('reports unavailable rather than throwing when the write fails', async () => {
    const t = db({ failWrite: true });
    await expect(provisionFamilyEmailLocal(t.client, 'fam-1', 'Smith')).resolves.toEqual({ assigned: false, reason: 'unavailable' });
  });

  it('gives up quietly when every candidate is taken', async () => {
    const t = db({ taken: new Set(candidateLocals('Smith', 'fam-1')) });
    const res = await provisionFamilyEmailLocal(t.client, 'fam-1', 'Smith');
    expect(res).toEqual({ assigned: false, reason: 'exhausted' });
  });

  it('never throws, whatever the client does', async () => {
    const exploding = { from: () => { throw new Error('client is gone'); } } as never;
    await expect(provisionFamilyEmailLocal(exploding, 'fam-1', 'Smith')).resolves.toEqual({ assigned: false, reason: 'unavailable' });
  });
});

describe('onboarding wiring', () => {
  it('provisions last and cannot fail the run', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('app/onboarding/actions.ts', 'utf8');
    const call = source.indexOf('provisionFamilyEmailLocal(');
    const done = source.indexOf('return { ok: true, data: { familyId, brief: finalBrief } };');
    expect(call).toBeGreaterThan(-1);
    // After every required write, immediately before the success return.
    expect(call).toBeLessThan(done);
    // Wrapped, and never converted into an onboardingFailure.
    const block = source.slice(call - 400, call + 500);
    expect(block).toContain('try {');
    expect(block).not.toContain('onboardingFailure');
    expect(block).not.toContain('return { ok: false');
  });
});
