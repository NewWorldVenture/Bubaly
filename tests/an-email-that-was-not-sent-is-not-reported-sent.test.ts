import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Found while running every scheduled job on a local build (the API audit's
// cron pass): /api/cron/weekly-digest reported {"sent":4} on a server with no
// email provider. sendEmail/sendReactEmail answer { ok: true, skipped: true }
// when RESEND_API_KEY is unset — a contract other callers rely on (the contact
// form files a ticket either way; see tests/email-send-contract.test.ts) — so
// a caller that reads only `ok` turns "nothing was sent" into "sent":
//
//  - the invite, welcome, referral and admin re-send flows told the person
//    their email had gone;
//  - (the notification digest was already safe: it returns before sending
//    when emailEnabled() is false; it now also refuses to stamp a skip);
//  - the weekly digest and chore reminders counted every skip as a send.
//
// Every caller that reads the result must read `skipped` too. Calls whose
// result is deliberately ignored (best-effort mail during onboarding, the
// feedback note) are not reading `ok` at all and are not held to this.

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : files(full);
    return /\.tsx?$/.test(name) ? [full.split(path.sep).join('/')] : [];
  });
}

const SENDERS = /\b(sendEmail|sendReactEmail)\(/;
const callers = [...files('app'), ...files('lib')]
  .filter((f) => !['lib/email.ts', 'lib/server/email.ts'].includes(f))
  .filter((f) => SENDERS.test(readFileSync(f, 'utf8')));

/** Each call's result binding: `const { ok } = await send…(` or `const x = await send…(`. */
function readsOkWithoutSkipped(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/const\s+(\{[^}]*\}|[A-Za-z_]\w*)\s*=\s*await\s+(?:sendEmail|sendReactEmail)\(/g)) {
    const binding = m[1];
    const after = src.slice(m.index!, m.index! + 2500);
    const readsSkipped = binding.startsWith('{')
      ? /\bskipped\b/.test(binding)
      : new RegExp(`\\b${binding}\\.skipped\\b`).test(after);
    if (!readsSkipped) out.push(binding);
  }
  return out;
}

describe('an email that was not sent is not reported as sent', () => {
  it('finds the callers', () => {
    expect(callers.length).toBeGreaterThanOrEqual(10);
  });

  it.each(callers)('%s reads `skipped` wherever it reads the result', (file) => {
    expect(readsOkWithoutSkipped(readFileSync(file, 'utf8')), file).toEqual([]);
  });

  it('can tell the two apart', () => {
    expect(readsOkWithoutSkipped('const { ok } = await sendReactEmail({});\nif (ok) sent++;')).toEqual(['{ ok }']);
    expect(readsOkWithoutSkipped('const { ok, skipped } = await sendReactEmail({});')).toEqual([]);
    expect(readsOkWithoutSkipped('const r = await sendEmail({});\nif (r.skipped) x();')).toEqual([]);
    expect(readsOkWithoutSkipped('const r = await sendEmail({});\nif (!r.ok) x();')).toEqual(['r']);
  });
});
