import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  captureFor, initialMicState, micAvailable, micErrorKey, micFlowStep, micLabelKey, runMicFlow,
  type MicState, type MicSupport,
} from '@/lib/voice/mic-flow';
import { MicButton } from '@/components/voice/mic-button';

// M19 — one mic, one flow. These prove the flow itself (including the 503
// fallback to on-device recognition) without a browser, and that the shared
// button renders NO microphone when the page is server-rendered.

const FULL: MicSupport = { recorder: true, speech: true };
const RECORDER_ONLY: MicSupport = { recorder: true, speech: false };
const SPEECH_ONLY: MicSupport = { recorder: false, speech: true };
const NONE: MicSupport = { recorder: false, speech: false };

describe('mic availability', () => {
  it('needs at least one capture path', () => {
    expect(micAvailable(FULL)).toBe(true);
    expect(micAvailable(RECORDER_ONLY)).toBe(true);
    expect(micAvailable(SPEECH_ONLY)).toBe(true);
    expect(micAvailable(NONE)).toBe(false);
  });

  it('prefers the recorder until the server says it cannot transcribe', () => {
    expect(captureFor(initialMicState, FULL)).toBe('recorder');
    expect(captureFor({ ...initialMicState, serverUnavailable: true }, FULL)).toBe('speech');
    // No on-device recognition to fall back to: still try the server.
    expect(captureFor({ ...initialMicState, serverUnavailable: true }, RECORDER_ONLY)).toBe('recorder');
    expect(captureFor(initialMicState, NONE)).toBeNull();
  });
});

describe('recorder path: idle → recording → transcribing → submit', () => {
  it('walks the happy path and hands the text out exactly once', () => {
    const pressed = micFlowStep(initialMicState, { type: 'press', support: FULL });
    expect(pressed.state.status).toBe('recording');
    expect(pressed.effects).toEqual([{ kind: 'start_recording' }]);

    const stopped = micFlowStep(pressed.state, { type: 'press', support: FULL });
    expect(stopped.state.status).toBe('transcribing');
    expect(stopped.effects).toEqual([{ kind: 'stop_recording' }]);

    const done = micFlowStep(stopped.state, { type: 'transcribed', text: '  Plan   dinners  ' });
    expect(done.state.status).toBe('idle');
    expect(done.effects).toEqual([{ kind: 'submit', text: 'Plan dinners' }]);
  });

  it('a press while transcribing is ignored rather than starting a second recording', () => {
    const transcribing: MicState = { ...initialMicState, status: 'transcribing' };
    const step = micFlowStep(transcribing, { type: 'press', support: FULL });
    expect(step.state).toEqual(transcribing);
    expect(step.effects).toEqual([]);
  });

  it('an empty transcript says so instead of submitting nothing', () => {
    const step = micFlowStep({ ...initialMicState, status: 'transcribing' }, { type: 'transcribed', text: '   ' });
    expect(step.state.error).toBe('no_speech');
    expect(step.effects).toEqual([]);
  });

  it('cancelling stops the stream and submits nothing', () => {
    const { state, effects } = runMicFlow([{ type: 'press', support: FULL }, { type: 'cancel' }]);
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
    expect(effects).toEqual([{ kind: 'start_recording' }, { kind: 'stop_recording' }]);
  });

  it('a denied microphone is reported as a permission problem, not a transcription one', () => {
    const step = runMicFlow([
      { type: 'press', support: FULL },
      { type: 'capture_failed', reason: 'permission' },
    ]);
    expect(step.state.status).toBe('idle');
    expect(step.state.error).toBe('permission');
    expect(step.state.serverUnavailable).toBe(false);
  });
});

describe('503 fallback: no transcription key → the browser listens instead', () => {
  it('switches to on-device recognition and remembers it for the session', () => {
    const step = runMicFlow([
      { type: 'press', support: FULL },
      { type: 'press', support: FULL },
      { type: 'transcribe_failed', status: 503, support: FULL },
    ]);
    expect(step.state.serverUnavailable).toBe(true);
    expect(step.state.status).toBe('listening');
    expect(step.state.capture).toBe('speech');
    // Never claims the failed recording succeeded.
    expect(step.effects).toEqual([
      { kind: 'start_recording' }, { kind: 'stop_recording' }, { kind: 'start_listening' },
    ]);

    // The NEXT press goes straight to the on-device path.
    const again = micFlowStep({ ...step.state, status: 'idle' }, { type: 'press', support: FULL });
    expect(again.state.status).toBe('listening');
    expect(again.effects).toEqual([{ kind: 'start_listening' }]);
  });

  it('with no Web Speech to fall back to, the 503 is surfaced as an error', () => {
    const step = runMicFlow([
      { type: 'press', support: RECORDER_ONLY },
      { type: 'press', support: RECORDER_ONLY },
      { type: 'transcribe_failed', status: 503, support: RECORDER_ONLY },
    ]);
    expect(step.state.status).toBe('idle');
    expect(step.state.error).toBe('transcribe_failed');
    expect(step.state.serverUnavailable).toBe(true);
    expect(step.effects.some((e) => e.kind === 'start_listening')).toBe(false);
  });

  it('a 502 is a bad transcription, not a missing key: the recorder stays the path', () => {
    const step = runMicFlow([
      { type: 'press', support: FULL },
      { type: 'press', support: FULL },
      { type: 'transcribe_failed', status: 502, support: FULL },
    ]);
    expect(step.state.serverUnavailable).toBe(false);
    expect(step.state.status).toBe('idle');
    expect(step.state.error).toBe('transcribe_failed');
    expect(captureFor(step.state, FULL)).toBe('recorder');
  });
});

describe('on-device path', () => {
  it('goes straight to listening when the browser cannot record', () => {
    const step = micFlowStep(initialMicState, { type: 'press', support: SPEECH_ONLY });
    expect(step.state.status).toBe('listening');
    expect(step.effects).toEqual([{ kind: 'start_listening' }]);
  });

  it('tap-to-stop sends what was heard', () => {
    const listening = micFlowStep(initialMicState, { type: 'press', support: SPEECH_ONLY }).state;
    const step = micFlowStep(listening, { type: 'press', support: SPEECH_ONLY, transcript: 'add milk' });
    expect(step.state.status).toBe('idle');
    expect(step.effects).toEqual([{ kind: 'stop_listening' }, { kind: 'submit', text: 'add milk' }]);
  });

  it('an automatic end after a pause submits the same way', () => {
    const listening = micFlowStep(initialMicState, { type: 'press', support: SPEECH_ONLY }).state;
    const step = micFlowStep(listening, { type: 'speech_result', text: 'plan the week' });
    expect(step.effects).toEqual([{ kind: 'stop_listening' }, { kind: 'submit', text: 'plan the week' }]);
  });

  it('hearing nothing is reported, never submitted as an empty request', () => {
    const listening = micFlowStep(initialMicState, { type: 'press', support: SPEECH_ONLY }).state;
    const step = micFlowStep(listening, { type: 'press', support: SPEECH_ONLY, transcript: '  ' });
    expect(step.state.error).toBe('no_speech');
    expect(step.effects).toEqual([{ kind: 'stop_listening' }]);
  });

  it('a recognition failure ends the session with an error', () => {
    const listening = micFlowStep(initialMicState, { type: 'press', support: SPEECH_ONLY }).state;
    const step = micFlowStep(listening, { type: 'speech_failed' });
    expect(step.state.status).toBe('idle');
    expect(step.state.error).toBe('capture_failed');
  });
});

describe('no capture at all', () => {
  it('says the browser cannot do it rather than pretending to listen', () => {
    const step = micFlowStep(initialMicState, { type: 'press', support: NONE });
    expect(step.state.status).toBe('idle');
    expect(step.state.error).toBe('unsupported');
    expect(step.effects).toEqual([]);
  });

  it('dismissing an error clears it without touching the flow', () => {
    const errored: MicState = { ...initialMicState, error: 'no_speech' };
    const step = micFlowStep(errored, { type: 'dismiss_error' });
    expect(step.state.error).toBeNull();
    expect(step.state.status).toBe('idle');
  });
});

describe('the machine speaks in catalogue keys, never English', () => {
  it('maps every error code and status to a key the UI translates', () => {
    for (const code of ['unsupported', 'permission', 'capture_failed', 'transcribe_failed', 'no_speech'] as const) {
      expect(micErrorKey(code)).toMatch(/^micButton\./);
    }
    for (const status of ['idle', 'recording', 'transcribing', 'listening'] as const) {
      expect(micLabelKey({ ...initialMicState, status })).toMatch(/^micButton\./);
    }
  });
});

describe('MicButton server-rendering', () => {
  // Client components are server-rendered by Next. A mic that appeared in SSR
  // markup would be a button that cannot record until hydration — and on a
  // browser with no microphone support, one that never can.
  it('renders no markup at all on the server, and never throws', () => {
    let html = '';
    expect(() => { html = renderToStaticMarkup(React.createElement(MicButton, { onTranscript: () => {} })); }).not.toThrow();
    expect(html).toBe('');
    expect(html).not.toContain('<button');
  });

  it('renders nothing for every size / disabled combination', () => {
    for (const size of ['sm', 'md'] as const) {
      for (const disabled of [true, false]) {
        expect(renderToStaticMarkup(React.createElement(MicButton, { onTranscript: () => {}, size, disabled }))).toBe('');
      }
    }
  });
});

describe('reporting a mic error cannot loop', () => {
  // The ⌘K bar passes `onError={(m) => { if (m) toastError(m); }}` — a new
  // closure on every render. Deny microphone permission there and the button
  // reports 'permission'; the toast that reports it re-renders the command bar,
  // which hands the button another closure. While the two notification effects
  // depended on the callbacks, that re-fired them, pushed another toast, and
  // looped until React's "Maximum update depth exceeded" took the app shell
  // down to the error boundary. Callbacks now go through refs, exactly as
  // onTranscript already did, so a surface may pass whatever it likes.
  const source = readFileSync('components/voice/mic-button.tsx', 'utf8');
  const effect = (dep: string) => source.split('\n').find((line) => line.includes(dep) && line.includes('useEffect')) ?? '';

  it('holds both notification callbacks in refs', () => {
    expect(source).toContain('const onErrorRef = useRef(onError);');
    expect(source).toContain('onErrorRef.current = onError;');
    expect(source).toContain('const onStatusChangeRef = useRef(onStatusChange);');
    expect(source).toContain('onStatusChangeRef.current = onStatusChange;');
  });

  it('notifies through the ref, so an inline closure is never called directly', () => {
    expect(source).toContain('onErrorRef.current?.(');
    expect(source).toContain('onStatusChangeRef.current?.(');
    // The props themselves are only read where the refs are filled.
    expect(source).not.toMatch(/onError\?\.\(/);
    expect(source).not.toMatch(/onStatusChange\?\.\(/);
  });

  it('re-fires only when the error or the status actually changes', () => {
    const errorEffect = effect('onErrorRef.current');
    expect(errorEffect).toContain('[state.error, t]');
    expect(errorEffect).not.toContain('onError,');
    const statusEffect = effect('onStatusChangeRef.current');
    expect(statusEffect).toContain('[state.status]');
    expect(statusEffect).not.toContain('onStatusChange,');
  });

  it('and the toast provider keeps one context identity across a toast', () => {
    // Second half of the same loop: <ToastContext.Provider> was handed a fresh
    // object every render, so pushing a toast changed context identity and
    // re-rendered every consumer of useToast().
    const toast = readFileSync('components/ui/toast.tsx', 'utf8');
    expect(toast).toContain('const api = useMemo<ToastApi>(');
    expect(toast).toContain('}), [push]);');
  });
});
