import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// P-38 (finalaudit.md, page audit B15). Every role's form pass was refused by
// the BROWSER on the same fields: a move's budget and mover's quote (step 50),
// a salary (step 100), a project's budget, labour and quote (step 10), a plan's
// budget (step 10). A number input rejects any value that is not a multiple of
// its `step`, so "Please enter a valid value" met a quote of $1,875, a budget
// of $125 or a salary of $65,432, and the form would not submit. Every one of
// these is stored in cents, so the field takes cents.

// Money, by the field's name, its aria-label key, or the state it writes.
const MONEY = /name="(budget|spent|mover_quote|salary_target|salary_min|salary_max|labor|amount|maxAmount)"|walletSettings\.approvalThreshold/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

const sites = [...files('components'), ...files('app')].flatMap((file) =>
  readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
    /type="number"/.test(line) && MONEY.test(line) ? [{ where: `${file}:${i + 1}`, line }] : []));

describe('a money field takes the exact amount', () => {
  it('finds the money fields at all', () => {
    // Non-vacuity: the thirteen B15 found, at least.
    expect(sites.length).toBeGreaterThanOrEqual(13);
  });

  it('none of them rounds the amount a person types to a step', () => {
    const coarse = sites.filter(({ line }) => {
      const step = /step=\{?"?([^"}\s]+)"?\}?/.exec(line)?.[1];
      return step !== undefined && step !== '0.01' && step !== 'any';
    }).map(({ where }) => where);
    expect(coarse).toEqual([]);
  });
});
