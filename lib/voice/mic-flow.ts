// lib/voice/mic-flow.ts — the microphone, as a pure state machine.
//
// Every Ask surface (Home's ask bar, ⌘K, Ask Bubaly, the assistant composer)
// runs the SAME flow, so the flow itself lives here rather than inside any one
// component:
//
//   idle ──press──▶ recording ──press──▶ transcribing ──text──▶ idle + submit
//                     │                       │
//                   cancel                 503 / no key
//                     │                       ▼
//                     └──────────────▶ listening (Web Speech, on-device)
//
// Two capture paths, one flow. `recorder` is MediaRecorder → POST
// /api/ai/voice/transcribe (accurate, needs a server key); `speech` is the
// browser's own Web Speech recognition (no key, no upload). When the server
// answers 503 — the honest "voice isn't configured" — the machine remembers
// that for the rest of the session and takes the on-device path from then on,
// instead of asking the person to record into an endpoint that cannot answer.
//
// Nothing here touches the DOM, a hook, or a network call: the component
// dispatches events and performs the effects the machine hands back, which is
// what makes the whole flow — including the 503 fallback — unit-testable.

/** What the person sees the mic doing. */
export type MicStatus = 'idle' | 'recording' | 'transcribing' | 'listening';

/** Which capture path the current attempt is using. */
export type MicCapture = 'recorder' | 'speech';

/**
 * Why the mic stopped, as a CODE rather than a sentence: the machine is shared
 * by every locale, so the words belong in the catalogue and the component maps
 * `micErrorKey(code)` to a key. A machine that returned English would make
 * every Ask surface untranslatable.
 */
export type MicErrorCode =
  | 'unsupported'      // neither a recorder nor speech recognition here
  | 'permission'       // the microphone was denied
  | 'capture_failed'   // recording could not start / died
  | 'transcribe_failed'// the server was reachable but could not transcribe
  | 'no_speech';       // nothing audible came back

export type MicState = {
  status: MicStatus;
  capture: MicCapture;
  /** Set once the server transcriber answered 503: stay on-device this session. */
  serverUnavailable: boolean;
  error: MicErrorCode | null;
};

/** What the surface can support right now (resolved on the client, never in SSR). */
export type MicSupport = {
  /** MediaRecorder + getUserMedia are available. */
  recorder: boolean;
  /** The Web Speech API is available. */
  speech: boolean;
};

export type MicEvent =
  /** The mic was tapped. `transcript` is what Web Speech has heard so far,
   *  which is what a tap-to-stop submits on the on-device path. */
  | { type: 'press'; support: MicSupport; transcript?: string }
  | { type: 'cancel' }
  /** Recording never got off the ground (permission denied, no device). */
  | { type: 'capture_failed'; reason: 'permission' | 'capture_failed' }
  /** The upload came back with text (or empty text, which is a real outcome). */
  | { type: 'transcribed'; text: string }
  /** The transcribe route failed. `status` 503 means "no key configured". */
  | { type: 'transcribe_failed'; status?: number; support: MicSupport }
  /** Web Speech produced its final text for this listening session. */
  | { type: 'speech_result'; text: string }
  | { type: 'speech_failed' }
  | { type: 'dismiss_error' };

export type MicEffect =
  | { kind: 'start_recording' }
  | { kind: 'stop_recording' }
  | { kind: 'start_listening' }
  | { kind: 'stop_listening' }
  /** Hand this text to the composer — the only way text leaves the machine. */
  | { kind: 'submit'; text: string };

export type MicStep = { state: MicState; effects: MicEffect[] };

export const initialMicState: MicState = {
  status: 'idle',
  capture: 'recorder',
  serverUnavailable: false,
  error: null,
};

/** Collapse whitespace; empty when there is nothing a person actually said. */
function tidy(raw: string): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

/** Catalogue key for an error code (the component owns the words). */
export function micErrorKey(code: MicErrorCode): string {
  switch (code) {
    case 'unsupported': return 'micButton.errorUnsupported';
    case 'permission': return 'micButton.errorPermission';
    case 'capture_failed': return 'micButton.errorCaptureFailed';
    case 'transcribe_failed': return 'micButton.errorTranscribeFailed';
    case 'no_speech': return 'micButton.errorNoSpeech';
  }
}

/** Catalogue key for the button's accessible name in this state. */
export function micLabelKey(state: MicState): string {
  switch (state.status) {
    case 'recording': return 'micButton.stopAndSend';
    case 'listening': return 'micButton.stopListening';
    case 'transcribing': return 'micButton.transcribing';
    case 'idle': return 'micButton.speak';
  }
}

/** A mic is worth rendering only when this browser can actually capture audio. */
export function micAvailable(support: MicSupport): boolean {
  return support.recorder || support.speech;
}

/** Which path a fresh press should take, given support and what the server has said. */
export function captureFor(state: MicState, support: MicSupport): MicCapture | null {
  if (support.recorder && !state.serverUnavailable) return 'recorder';
  if (support.speech) return 'speech';
  // No speech recognition here, but a recorder — try the server even after a
  // 503: a key may have been added since, and failing loudly beats no mic.
  if (support.recorder) return 'recorder';
  return null;
}

/** End a listening session: submit what was heard, or say nothing was. */
function finishListening(state: MicState, heard: string): MicStep {
  const text = tidy(heard);
  if (!text) return { state: { ...state, status: 'idle', error: 'no_speech' }, effects: [{ kind: 'stop_listening' }] };
  return { state: { ...state, status: 'idle', error: null }, effects: [{ kind: 'stop_listening' }, { kind: 'submit', text }] };
}

/**
 * One transition. Returns the next state plus the effects the caller must run —
 * pure, total, and never throws: an event that makes no sense in the current
 * state leaves the state alone.
 */
export function micFlowStep(state: MicState, event: MicEvent): MicStep {
  switch (event.type) {
    case 'press': {
      if (state.status === 'recording') {
        return { state: { ...state, status: 'transcribing', error: null }, effects: [{ kind: 'stop_recording' }] };
      }
      if (state.status === 'listening') {
        // Tap-to-stop on the on-device path sends what was heard, exactly as
        // tap-to-stop on the recorder path sends what was recorded.
        return finishListening(state, event.transcript ?? '');
      }
      if (state.status === 'transcribing') return { state, effects: [] };

      const capture = captureFor(state, event.support);
      if (!capture) {
        return { state: { ...state, status: 'idle', error: 'unsupported' }, effects: [] };
      }
      return capture === 'recorder'
        ? { state: { ...state, status: 'recording', capture, error: null }, effects: [{ kind: 'start_recording' }] }
        : { state: { ...state, status: 'listening', capture, error: null }, effects: [{ kind: 'start_listening' }] };
    }

    case 'cancel': {
      if (state.status === 'recording') return { state: { ...state, status: 'idle', error: null }, effects: [{ kind: 'stop_recording' }] };
      if (state.status === 'listening') return { state: { ...state, status: 'idle', error: null }, effects: [{ kind: 'stop_listening' }] };
      return { state: { ...state, status: 'idle', error: null }, effects: [] };
    }

    case 'capture_failed':
      return { state: { ...state, status: 'idle', error: event.reason }, effects: [] };

    case 'transcribed': {
      const text = tidy(event.text);
      if (!text) return { state: { ...state, status: 'idle', error: 'no_speech' }, effects: [] };
      return { state: { ...state, status: 'idle', error: null }, effects: [{ kind: 'submit', text }] };
    }

    case 'transcribe_failed': {
      // 503 is the route's honest "voice isn't configured". The recording is
      // already lost, so the fallback is offered for the NEXT press rather than
      // pretended to be this one — and the person is told, not left guessing.
      const serverUnavailable = state.serverUnavailable || event.status === 503;
      const canFallBack = serverUnavailable && event.support.speech;
      return {
        state: {
          ...state,
          status: canFallBack ? 'listening' : 'idle',
          capture: canFallBack ? 'speech' : state.capture,
          serverUnavailable,
          error: canFallBack ? null : 'transcribe_failed',
        },
        effects: canFallBack ? [{ kind: 'start_listening' }] : [],
      };
    }

    case 'speech_result':
      return finishListening(state, event.text);

    case 'speech_failed':
      return { state: { ...state, status: 'idle', error: 'capture_failed' }, effects: [{ kind: 'stop_listening' }] };

    case 'dismiss_error':
      return { state: { ...state, error: null }, effects: [] };
  }
}

/** Run a whole sequence of events — handy in tests and for replaying a session. */
export function runMicFlow(events: MicEvent[], start: MicState = initialMicState): MicStep {
  let state = start;
  const effects: MicEffect[] = [];
  for (const event of events) {
    const step = micFlowStep(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}
