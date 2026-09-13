import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  issueAssistantToken, hashAssistantToken, assistantTokenMatches,
  looksLikeAssistantToken, readPresentedToken, ASSISTANT_TOKEN_PREFIX,
} from '@/lib/assistant/link-token';
import {
  alexaAccessToken, alexaUtterance, alexaSpeechResponse, alexaSilentResponse,
  ALEXA_NOT_LINKED_SPEECH, type AlexaRequestBody,
} from '@/lib/assistant/alexa';
import { dayKey, dayWindow } from '@/lib/assistant/service';

describe('a token that can write is never stored in the clear', () => {
  it('issues a secret, a hash and a display prefix', () => {
    const issued = issueAssistantToken();
    expect(issued.token.startsWith(ASSISTANT_TOKEN_PREFIX)).toBe(true);
    expect(issued.tokenHash).toBe(hashAssistantToken(issued.token));
    expect(issued.token.startsWith(issued.tokenPrefix)).toBe(true);
  });

  it('keeps the stored form clear of the secret', () => {
    // The point of hashing: a dump of assistant_links must hand an attacker
    // nothing replayable.
    const issued = issueAssistantToken();
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.token).not.toContain(issued.tokenHash);
    expect(issued.tokenPrefix.length).toBeLessThan(issued.token.length / 2);
  });

  it('issues a different token every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => issueAssistantToken().token));
    expect(seen.size).toBe(50);
  });

  it('matches the right token and rejects a near miss', () => {
    const issued = issueAssistantToken();
    expect(assistantTokenMatches(issued.token, issued.tokenHash)).toBe(true);
    expect(assistantTokenMatches(`${issued.token}x`, issued.tokenHash)).toBe(false);
    expect(assistantTokenMatches(issueAssistantToken().token, issued.tokenHash)).toBe(false);
  });

  it('survives the whitespace a paste into a Shortcut adds', () => {
    const issued = issueAssistantToken();
    expect(assistantTokenMatches(` ${issued.token}\n`, issued.tokenHash)).toBe(true);
  });

  it('rejects obvious junk before any database work', () => {
    expect(looksLikeAssistantToken(issueAssistantToken().token)).toBe(true);
    expect(looksLikeAssistantToken('hunter2')).toBe(false);
    expect(looksLikeAssistantToken(`${ASSISTANT_TOKEN_PREFIX}short`)).toBe(false);
    expect(looksLikeAssistantToken(`${ASSISTANT_TOKEN_PREFIX}${'x'.repeat(400)}`)).toBe(false);
    expect(looksLikeAssistantToken(null)).toBe(false);
    expect(looksLikeAssistantToken(12345)).toBe(false);
  });
});

describe('reading the token out of whichever place the assistant put it', () => {
  const token = issueAssistantToken().token;

  it('takes a bearer header', () => {
    expect(readPresentedToken(`Bearer ${token}`)).toBe(token);
    expect(readPresentedToken(`bearer ${token}`)).toBe(token);
  });

  it('takes a body field, which is what a simple webhook can send', () => {
    expect(readPresentedToken(null, token)).toBe(token);
  });

  it('prefers the header when both are present', () => {
    const other = issueAssistantToken().token;
    expect(readPresentedToken(`Bearer ${token}`, other)).toBe(token);
  });

  it('returns null rather than a malformed value', () => {
    expect(readPresentedToken('Bearer nope')).toBeNull();
    expect(readPresentedToken(null, 'nope')).toBeNull();
    expect(readPresentedToken(null, undefined)).toBeNull();
    expect(readPresentedToken('Basic abc')).toBeNull();
  });
});

describe('Alexa speaks a different shape to everyone else', () => {
  const withToken = (token: string): AlexaRequestBody => ({ session: { user: { accessToken: token } } });

  it('finds the token in the session', () => {
    expect(alexaAccessToken(withToken('abc'))).toBe('abc');
  });

  it('finds it in context.System when there is no session', () => {
    // Which of the two Alexa uses depends on how the skill was invoked, so
    // reading only one works in testing and fails for real users.
    expect(alexaAccessToken({ context: { System: { user: { accessToken: 'abc' } } } })).toBe('abc');
  });

  it('reports no token rather than an empty string', () => {
    expect(alexaAccessToken({})).toBeNull();
    expect(alexaAccessToken({ session: { user: {} } })).toBeNull();
  });

  it('turns "open Bubaly" into the help prompt', () => {
    expect(alexaUtterance({ request: { type: 'LaunchRequest' } })).toEqual({ kind: 'utterance', utterance: '' });
  });

  it('answers a closing session with silence', () => {
    // Speaking here makes the device report an error to the user.
    expect(alexaUtterance({ request: { type: 'SessionEndedRequest' } })).toEqual({ kind: 'silent' });
    expect(alexaUtterance({ request: { type: 'IntentRequest', intent: { name: 'AMAZON.StopIntent' } } }))
      .toEqual({ kind: 'silent' });
    expect(alexaUtterance({ request: { type: 'IntentRequest', intent: { name: 'AMAZON.CancelIntent' } } }))
      .toEqual({ kind: 'silent' });
  });

  it('maps the built-in help intents', () => {
    expect(alexaUtterance({ request: { type: 'IntentRequest', intent: { name: 'AMAZON.HelpIntent' } } }))
      .toEqual({ kind: 'utterance', utterance: 'help' });
    expect(alexaUtterance({ request: { type: 'IntentRequest', intent: { name: 'AMAZON.FallbackIntent' } } }))
      .toEqual({ kind: 'utterance', utterance: 'help' });
  });

  it('reads the query out of the slot', () => {
    expect(alexaUtterance({
      request: { type: 'IntentRequest', intent: { name: 'AskBubaly', slots: { query: { name: 'query', value: "what's on today" } } } },
    })).toEqual({ kind: 'utterance', utterance: "what's on today" });
  });

  it('skips the empty slots Alexa sends alongside the filled one', () => {
    // Alexa sends every DECLARED slot whether or not it was filled. Taking the
    // first one regardless yields an empty utterance whenever an unfilled slot
    // happens to come first.
    expect(alexaUtterance({
      request: {
        type: 'IntentRequest',
        intent: { name: 'AskBubaly', slots: { aEmpty: { name: 'aEmpty', value: '' }, query: { name: 'query', value: 'what is next' } } },
      },
    })).toEqual({ kind: 'utterance', utterance: 'what is next' });
  });

  it('degrades to the help prompt when nothing was filled', () => {
    expect(alexaUtterance({ request: { type: 'IntentRequest', intent: { name: 'AskBubaly', slots: {} } } }))
      .toEqual({ kind: 'utterance', utterance: '' });
  });

  it('builds the envelope Alexa expects', () => {
    const response = alexaSpeechResponse('You have 1 thing today: Dentist at 3pm.');
    expect(response.version).toBe('1.0');
    expect(response.response.outputSpeech).toEqual({ type: 'PlainText', text: 'You have 1 thing today: Dentist at 3pm.' });
    expect(response.response.shouldEndSession).toBe(true);
    expect(response.response.card?.title).toBe('Bubaly');
  });

  it('never holds the session open, so a device does not sit listening', () => {
    expect(alexaSilentResponse().response.shouldEndSession).toBe(true);
    expect(alexaSpeechResponse('x').response.shouldEndSession).toBe(true);
  });

  it('omits the card when there is nothing to show', () => {
    expect(alexaSpeechResponse('', false).response.card).toBeUndefined();
    expect(alexaSilentResponse().response.outputSpeech).toBeUndefined();
  });

  it('tells an unlinked user what to do rather than just failing', () => {
    expect(ALEXA_NOT_LINKED_SPEECH).toContain('link your Bubaly account');
  });
});

describe('"today" means the family’s today', () => {
  it('reads the day in the family’s zone, not the server’s', () => {
    // 01:00 UTC on the 11th is still the 10th in New York. A server-side date
    // would read the wrong day's calendar for a third of every day.
    const instant = new Date('2026-03-11T01:00:00Z');
    expect(dayKey(instant, 'America/New_York')).toBe('2026-03-10');
    expect(dayKey(instant, 'UTC')).toBe('2026-03-11');
    expect(dayKey(instant, 'Asia/Tokyo')).toBe('2026-03-11');
  });

  it('spans local midnight to local midnight', () => {
    // 10 March 2026 is AFTER the 8 March switch, so New York is on EDT (UTC-4)
    // and local midnight is 04:00Z. Asserting 05:00 here was me reading the
    // offset off the calendar rather than off the zone.
    const window = dayWindow(new Date('2026-03-11T01:00:00Z'), 'America/New_York');
    expect(window.from).toBe('2026-03-10T04:00:00.000Z');
    expect(window.to).toBe('2026-03-11T04:00:00.000Z');
  });

  it('uses the offset in force on the day, not a fixed one for the zone', () => {
    // The same zone, two months apart, two different offsets. This is the whole
    // reason the window is resolved through Intl rather than by arithmetic.
    expect(dayWindow(new Date('2026-01-15T12:00:00Z'), 'America/New_York').from)
      .toBe('2026-01-15T05:00:00.000Z'); // EST
    expect(dayWindow(new Date('2026-07-15T12:00:00Z'), 'America/New_York').from)
      .toBe('2026-07-15T04:00:00.000Z'); // EDT
  });

  it('shifts a whole day for tomorrow', () => {
    const today = dayWindow(new Date('2026-06-15T12:00:00Z'), 'UTC', 0);
    const tomorrow = dayWindow(new Date('2026-06-15T12:00:00Z'), 'UTC', 1);
    expect(today.to).toBe(tomorrow.from);
  });

  it('stays a real day across a DST change', () => {
    // The spring-forward day is 23 hours long, and this test used to assert 24
    // — the comment beside it described the defect correctly and then pinned it
    // anyway ("the window is a fixed span"). A fixed span runs an hour into
    // tomorrow every spring, so today's agenda read out tomorrow's first
    // appointment.
    const spring = dayWindow(new Date('2026-03-08T12:00:00Z'), 'America/New_York');
    expect(spring.from).toBe('2026-03-08T05:00:00.000Z');
    expect((Date.parse(spring.to) - Date.parse(spring.from)) / 3_600_000).toBe(23);
    expect(dayKey(new Date(spring.from), 'America/New_York')).toBe('2026-03-08');

    // And the fall-back day is 25 hours. The fixed span stopped an hour early,
    // silently dropping the last hour of the evening.
    const autumn = dayWindow(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
    expect((Date.parse(autumn.to) - Date.parse(autumn.from)) / 3_600_000).toBe(25);
    expect(dayKey(new Date(autumn.from), 'America/New_York')).toBe('2026-11-01');
  });

  it('hands today straight over to tomorrow with no gap or overlap, DST or not', () => {
    for (const day of ['2026-03-08', '2026-11-01', '2026-07-15']) {
      const at = new Date(`${day}T12:00:00Z`);
      expect(dayWindow(at, 'America/New_York', 0).to, day).toBe(dayWindow(at, 'America/New_York', 1).from);
    }
  });
});

describe('the endpoints refuse before they look anything up', () => {
  const generic = readFileSync('app/api/assistant/route.ts', 'utf8');
  const alexa = readFileSync('app/api/assistant/alexa/route.ts', 'utf8');

  it('rate limits by IP before touching the token', () => {
    // Otherwise the endpoint is a way to test guessed tokens at speed.
    //
    // Compared at the CALL sites. The first attempt compared the first
    // occurrence of each name, and `resolveAssistantLink` appears first in the
    // import block at the top of the file — so it measured import order and
    // would have failed no matter how the handler was written.
    const limitIndex = generic.indexOf('rateLimit(`assistant');
    const lookupIndex = generic.indexOf('await resolveAssistantLink(');
    expect(limitIndex).toBeGreaterThan(-1);
    expect(lookupIndex).toBeGreaterThan(-1);
    expect(limitIndex).toBeLessThan(lookupIndex);
  });

  it('bounds the request body', () => {
    // Either spelling is fine — what matters is that neither route hands the
    // platform an unbounded body. Alexa's reads BYTES rather than parsed JSON
    // because Amazon's signature covers exactly what arrived; re-serialising a
    // parsed envelope changes whitespace and key order and the signature would
    // never verify again.
    expect(generic).toContain('readBoundedRequestJson');
    expect(alexa).toContain('readBoundedRequestBytes');
    for (const source of [generic, alexa]) expect(source).toMatch(/MAX_BODY_BYTES/);
  });

  it('answers unknown and revoked tokens identically', () => {
    // Two different replies would make this an oracle for guessing tokens.
    expect(generic.match(/status: 401/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('speaks its failures to Alexa instead of returning an error status', () => {
    // A non-200 becomes "there was a problem with the requested skill's
    // response", which tells the person nothing about what to fix. So every
    // failure that a DEVICE can reach is 200 with speech in it.
    //
    // The exception, and the reason this is not simply "no 4xx anywhere": a
    // request that cannot be proven to come from Amazon is not a device in
    // somebody's kitchen. There is nobody to speak to, speech would confirm to
    // the sender that the endpoint is live, and Amazon's own certification
    // requires a non-2xx there. So the property is checked as: every status
    // this route returns is either 200 or one of the three that only an
    // unverifiable request can reach.
    const statuses = [...alexa.matchAll(/status: (\d{3})/g)].map((match) => match[1]);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => ['400', '403', '413'].includes(status))).toBe(true);
    // And none of them carries speech.
    expect(alexa).not.toMatch(/alexaSpeechResponse\([^)]*\)[^;]*status:/);
    expect(alexa).toContain('ALEXA_NOT_LINKED_SPEECH');
    // The spoken failures are still spoken.
    expect(alexa).toMatch(/return NextResponse\.json\(alexaSpeechResponse\(ALEXA_NOT_LINKED_SPEECH\)\)/);
    expect(alexa).toMatch(/alexaSpeechResponse\(ERROR_SPEECH\)/);
  });

  it('scopes every read to the family the token resolved to', () => {
    const service = readFileSync('lib/assistant/service.ts', 'utf8');
    // The ROUTE creates the service client and hands it in; the service layer
    // takes a client as a parameter and creates none. That is worth asserting
    // in this direction — a lib that reached for its own service-role client
    // would be usable from anywhere, including a context that had not checked a
    // token first.
    expect(generic).toContain('createServiceClient');
    expect(service).not.toContain('createServiceClient(');
    // And no family id is ever taken from the request body.
    expect(generic).not.toMatch(/payload\.\s*family/);

    // The property that actually matters, checked as a property rather than as
    // a count of one spelling: every family_id written anywhere in this file
    // comes from the resolved link. Counting occurrences of one literal was the
    // first attempt, and it passed or failed on how the helpers happened to
    // name their parameter.
    const assigned = [...service.matchAll(/family_id:\s*([A-Za-z0-9_.]+)/g)]
      .map((match) => match[1])
      .filter((source) => source !== 'string'); // type declarations, not writes
    expect(assigned.length).toBeGreaterThanOrEqual(3);
    expect(assigned.every((source) => source === 'link.family_id' || source === 'row.family_id')).toBe(true);

    // And every read is filtered by one, whatever the local name is.
    const filtered = [...service.matchAll(/\.eq\('family_id',\s*([A-Za-z0-9_.]+)\)/g)].map((m) => m[1]);
    expect(filtered.length).toBeGreaterThanOrEqual(2);
    expect(filtered.every((source) => source === 'familyId' || source === 'link.family_id')).toBe(true);
  });
});
