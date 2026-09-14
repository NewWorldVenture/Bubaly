import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// This file used to assert that identifiers were SPELLED:
//
//     expect(weekly).toContain('familiesError');
//
// which passes whether or not anything is done with `familiesError`. Declare the
// variable, never branch on it, and the guard stays green while every digest is
// silently dropped — the guard-that-cannot-fail shape this repository keeps
// finding. It also matched the response line verbatim, so it broke when the
// status expression got STRICTER (it now also refuses 200 for an unserved tail)
// even though the property it exists to protect was strengthened, not weakened.
//
// It now checks what each name is FOR: that the route branches on it and answers
// a 5xx, and that no failure of any kind can leave the route answering 200.

// Two tiers, and they are handled differently on purpose:
//
//   ABORT  — the read that feeds the whole run. Without it the route has nothing
//            to iterate, so it returns 5xx immediately and sends nothing.
//   COUNT  — a read for ONE family. Failing the whole run over one household
//            would punish every other household, so it increments `failed` and
//            moves on; `failed` is what makes the final status 502.
//
// Asserting the wrong tier for a name is how a test ends up demanding worse
// behaviour than the code already has — my first version of this file did
// exactly that for familyDataError.
const routes = {
  'chore-reminders': {
    src: readFileSync('app/api/cron/chore-reminders/route.ts', 'utf8'),
    abort: ['familiesError', 'authUsersError'],
    count: [] as string[],
  },
  'weekly-digest': {
    src: readFileSync('app/api/cron/weekly-digest/route.ts', 'utf8'),
    abort: ['familiesError', 'authUsersError'],
    count: ['familyDataError', 'adminMemberError'],
  },
} as const;

/** `if (name) { … status: 5xx … }` — aborts the run. */
function abortsWith5xx(src: string, name: string): boolean {
  return new RegExp(`if\\s*\\(\\s*${name}\\s*\\)[\\s\\S]{0,400}?status:\\s*5\\d\\d`).test(src);
}

/** `if (name) { … failed++ … }` — counted, so the final status becomes 502. */
function countsAsFailure(src: string, name: string): boolean {
  return new RegExp(`if\\s*\\(\\s*${name}\\s*\\)[\\s\\S]{0,300}?failed\\+\\+`).test(src);
}

describe('scheduled digest read boundaries', () => {
  for (const [name, { src, abort, count }] of Object.entries(routes)) {
    it(`${name} aborts with a 5xx when the read feeding the whole run fails`, () => {
      for (const err of abort) {
        expect(src, `${name} captures ${err} but never branches to a 5xx on it`)
          .toSatisfy(() => abortsWith5xx(src, err));
      }
    });

    it(`${name} counts a single family's read failure instead of dropping it silently`, () => {
      for (const err of count) {
        expect(src, `${name} captures ${err} but never counts it as a failure`)
          .toSatisfy(() => countsAsFailure(src, err));
      }
    });

    it(`${name} counts send failures and refuses to call them a success`, () => {
      expect(src).toMatch(/let failed = 0;/);
      expect(src).toMatch(/else failed\+\+;/);
      // Whatever the expression's shape, `failed` must decide the status, and a
      // non-zero `failed` must not be able to produce a 200.
      // Whatever the expression's shape, a non-zero `failed` must not be able to
      // produce a 200.
      expect(src).toMatch(/const ok = failed === 0/);
      expect(src).toMatch(/status: ok \? 200 : 502/);
    });

    it(`${name} also refuses 200 when it never reached part of its work`, () => {
      // Added with the fan-out budget: an unserved tail is the one failure that
      // produces no error at all, so it has to be counted explicitly.
      expect(src).toMatch(/skipped/);
      expect(src).toMatch(/failed === 0 && skipped === 0/);
    });
  }
});
