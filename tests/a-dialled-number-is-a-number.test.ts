// `<Dial>` is the one TwiML verb where unescaped content is not a broken
// sentence but a different phone call.
//
// `family_contact_channels.forward_to_phone` is the family's human fallback: the
// voice route transfers callers to it, and three escalation paths text it.
// `updateConciergeAction` wrote it with no trim, no cap and no shape check —
// `patch.forward_to_phone = input.forwardTo` — while the `greeting` two lines
// above, which is only ever SPOKEN, was trimmed and capped at 500. The field
// that gets dialled was the unvalidated one.
//
// And `twimlDial` was the only builder in lib/guardian/twilio.ts that did not
// escape. `twimlSay`, `twimlGather` and `twimlRecord` all escape their text; it
// interpolated both the number and the caller id raw.
//
// Setting the fallback requires `guardParentPlus`, so this is not an escalation
// — a manager can only aim it at their own family's Twilio bill. It is filed on
// the strength of the shape rather than the threat: a value that is not a number
// reaching a verb that dials, past a sibling field that is validated, through
// the one builder in its file that does not escape. Audit C1-S7-05.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { twimlDial } from '@/lib/guardian/twilio';
import { toE164 } from '@/lib/guardian/phone';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('a dialled number is a number (C1-S7-05)', () => {
  it('a second destination cannot be appended through the number', () => {
    // The whole point. Without escaping this renders two <Dial> verbs and the
    // family's account pays for wherever the second one goes.
    const out = twimlDial('+15551234567</Dial><Dial>+19005551234');
    expect(out.match(/<Dial/g), 'the payload opened a second Dial verb').toHaveLength(1);
    expect(out).not.toContain('</Dial><Dial>');
    expect(out).toContain('&lt;/Dial&gt;');
  });

  it('a caller id cannot break out of its attribute', () => {
    const out = twimlDial('+15551234567', '+1555"><Dial>+19005551234</Dial><x y="');
    expect(out.match(/<Dial/g), 'the caller id opened a second Dial verb').toHaveLength(1);
    expect(out).toContain('&quot;');
  });

  it('an ordinary transfer still renders normally', () => {
    // The fix must not break the thing it guards.
    expect(twimlDial('+15551234567')).toBe('<Dial>+15551234567</Dial>');
    expect(twimlDial('+15551234567', '+15557654321'))
      .toBe('<Dial callerId="+15557654321">+15551234567</Dial>');
  });

  it.each([
    ['(555) 123-4567', '+15551234567'],
    ['555-123-4567', '+15551234567'],
    ['15551234567', '+15551234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+15551234567', '+15551234567'],
  ])('normalises %s', (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it.each([
    ['+15551234567</Dial><Dial>+19005551234'],
    ['not a phone number'],
    ['123'],
    ['+1'],
    ['+123456789012345678'],
    [''],
    ['   '],
  ])('refuses %s', (input) => {
    expect(toE164(input)).toBeNull();
  });

  it('the write path normalises instead of storing what it was given', () => {
    const src = read('app/(app)/dashboard/contact-center/actions.ts');
    expect(src, 'forward_to_phone is stored raw again').not.toMatch(
      /patch\.forward_to_phone = input\.forwardTo;/,
    );
    expect(src).toMatch(/toE164\(input\.forwardTo\)/);
  });

  it('clearing the fallback is still possible', () => {
    // A guard that refuses null would trap a family into forwarding forever.
    const src = read('app/(app)/dashboard/contact-center/actions.ts');
    expect(src).toMatch(/cleared/);
    expect(toE164(null)).toBeNull();
  });

  it('every TwiML builder that interpolates text escapes it', () => {
    // The class, not the one instance. twimlDial was the only builder in this
    // file without an escape, and it was the only one that dials.
    const src = read('lib/guardian/twilio.ts');
    for (const fn of ['twimlSay', 'twimlGather', 'twimlRecord', 'twimlDial']) {
      const start = src.indexOf(`export function ${fn}`);
      expect(start, `${fn} is gone; update this list`).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\nexport ', start + 1));
      expect(body, `${fn} interpolates into markup without escaping`).toMatch(/replace\(\/&\/g/);
    }
  });
});
