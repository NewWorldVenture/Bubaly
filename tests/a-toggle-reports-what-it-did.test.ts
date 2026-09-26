// Two reads that answered with a claim instead of an error.
//
// `/api/blog/save` batched its count and this-reader's-save reads with
// `Promise.all` and dropped both errors. `count: 0` over an unreadable aggregate
// says nobody saved the article; `saved: false` over an unreadable row says
// something about THE READER, and that one has teeth — the heart renders empty
// for an article they have saved, and the toggle behind it removes the bookmark
// on their next tap.
//
// And POST re-read the state it had just written, so a read that failed after a
// write that succeeded reported the opposite of what had happened.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const save = readFileSync('app/api/blog/save/route.ts', 'utf8');
const referrals = readFileSync('app/(app)/referrals/page.tsx', 'utf8');
const heart = readFileSync('components/blog/heart-button.tsx', 'utf8');

describe('a toggle reports what it did', () => {
  it('POST derives saved from the branch it took, not from a re-read', () => {
    // The write is the fact. `saveState` is consulted for the COUNT only.
    const body = save.slice(save.indexOf('export async function POST'));
    expect(body).toMatch(/let saved = true;/);
    expect(body).toMatch(/saved = false;/);
    const derived = body.indexOf('let saved = true;');
    const reread = body.indexOf('await saveState(');
    expect(derived).toBeGreaterThan(-1);
    expect(derived).toBeLessThan(reread);
    // And what it returns is that variable, not the re-read's field.
    expect(body).toMatch(/\{ saved, count: error \? null : count, authenticated: true \}/);
  });

  it('an unreadable count is reported as unknown, never as zero', () => {
    expect(save).toContain('count: error ? null : count');
    // The client keeps its own number when the field is not one, so "unknown"
    // survives as the last good count rather than collapsing to nought.
    expect(heart).toContain("typeof d.count === 'number' ? d.count : prevCount");
  });

  it('GET answers 503 rather than asserting a state it could not read', () => {
    const body = save.slice(save.indexOf('export async function GET'));
    expect(body).toMatch(/if \(error\) \{/);
    expect(body).toMatch(/status: 503/);
    // The client's `r.ok ? r.json() : null` then leaves its state untouched.
    expect(heart).toContain('r.ok ? r.json() : null');
  });

  it('the batched reads are settled, so a rejection cannot follow a write', () => {
    expect(save).toContain('await settleAll([');
    expect(save).not.toMatch(/await Promise\.all\(\[/);
  });

  it('the referrals page reads the error on its referred-by check', () => {
    // Every other read on that page fails CLOSED — listReferralsForFamily and
    // getOrCreateReferralCode both throw rather than render an empty world. This
    // one dropped its error and handed the panel `alreadyReferred: false`, which
    // is a claim about the family: one that HAD been referred was offered the
    // "enter a code" box again, and the write behind it can only fail.
    expect(referrals).toContain('error: wasReferredError');
    const read = referrals.indexOf('const { data: wasReferred, error: wasReferredError }');
    const check = referrals.indexOf('if (wasReferredError)');
    const use = referrals.indexOf('alreadyReferred={Boolean(wasReferred)}');
    expect(read).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(read);
    expect(check).toBeLessThan(use);
  });
});
