// lib/assistant/alexa.ts
//
// Translating between Alexa's request/response envelopes and the neutral
// utterance-in / speech-out shape the rest of the bridge uses. PURE, so the
// mapping is testable without Alexa, a skill, or a device.
//
// Alexa is the awkward one of the assistants and that is what this file
// absorbs. It sends four different request types; it puts the linked account's
// token in one of two places depending on the request; it sends empty slots
// rather than omitting them; and SessionEndedRequest must be answered with no
// speech at all or the device reports an error to the user.

export type AlexaRequestBody = {
  version?: string;
  session?: { user?: { accessToken?: string } };
  context?: { System?: { user?: { accessToken?: string } } };
  request?: {
    type?: string;
    intent?: { name?: string; slots?: Record<string, { name?: string; value?: string }> };
  };
};

export type AlexaTranslation =
  /** Speak this and close. */
  | { kind: 'utterance'; utterance: string }
  /** Alexa is closing the session; answer with silence. */
  | { kind: 'silent' };

/**
 * Where the linked account's token is.
 *
 * Alexa puts it in `session.user` on a request that has a session and in
 * `context.System.user` on one that does not, and which you get depends on how
 * the skill was invoked. Reading only one of them works in testing and fails
 * for real users, so both are checked.
 */
export function alexaAccessToken(body: AlexaRequestBody): string | null {
  return body.session?.user?.accessToken
    ?? body.context?.System?.user?.accessToken
    ?? null;
}

/** Built-in intents Alexa sends that mean "stop", not "do something". */
const STOP_INTENTS = new Set(['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent']);
const HELP_INTENTS = new Set(['AMAZON.HelpIntent', 'AMAZON.FallbackIntent']);

/**
 * The spoken text, whatever shape Alexa wrapped it in.
 *
 * A LaunchRequest ("Alexa, open Bubaly") carries no words at all, so it becomes
 * the help prompt — which is what a person who just opened a skill needs to
 * hear anyway.
 */
export function alexaUtterance(body: AlexaRequestBody): AlexaTranslation {
  const type = body.request?.type ?? '';
  if (type === 'SessionEndedRequest') return { kind: 'silent' };
  if (type === 'LaunchRequest') return { kind: 'utterance', utterance: '' };

  const name = body.request?.intent?.name ?? '';
  if (STOP_INTENTS.has(name)) return { kind: 'silent' };
  if (HELP_INTENTS.has(name)) return { kind: 'utterance', utterance: 'help' };

  const slots = body.request?.intent?.slots ?? {};
  // Alexa sends every declared slot whether or not it was filled, so the first
  // NON-EMPTY one is the query — taking the first slot regardless would hand
  // the bridge an empty string from an unfilled slot that happened to sort
  // earlier.
  for (const slot of Object.values(slots)) {
    const value = (slot?.value ?? '').trim();
    if (value) return { kind: 'utterance', utterance: value };
  }
  return { kind: 'utterance', utterance: '' };
}

export type AlexaResponse = {
  version: '1.0';
  response: {
    outputSpeech?: { type: 'PlainText'; text: string };
    card?: { type: 'Simple'; title: string; content: string };
    shouldEndSession: boolean;
  };
};

/** The envelope Alexa expects back. */
export function alexaSpeechResponse(speech: string, withCard = true): AlexaResponse {
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: speech },
      // The card is what the person sees in the Alexa app afterwards. Useful
      // for an agenda they want to check later; skipped for an empty reply.
      ...(withCard && speech ? { card: { type: 'Simple' as const, title: 'Bubaly', content: speech } } : {}),
      // Always true: this bridge answers one question per invocation rather
      // than holding a conversation open, and a session left open makes the
      // device listen at a family for no reason.
      shouldEndSession: true,
    },
  };
}

/** Silence, for the request types that must not speak. */
export function alexaSilentResponse(): AlexaResponse {
  return { version: '1.0', response: { shouldEndSession: true } };
}

/** What Alexa says when the skill is not linked to a Bubaly account yet. */
export const ALEXA_NOT_LINKED_SPEECH =
  'Bubaly is not linked to an account yet. Open the Alexa app and link your Bubaly account, '
  + 'or paste an assistant key from Bubaly under Settings, Assistants.';
