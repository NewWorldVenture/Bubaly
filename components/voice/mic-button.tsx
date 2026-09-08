'use client';

// components/voice/mic-button.tsx — THE microphone. One button, mounted on
// every Ask surface (Home's ask bar, the ⌘K command bar, Ask Bubaly, the
// assistant composer), so "talk to Bubaly" behaves identically wherever the
// person happens to be.
//
// The flow itself is the pure machine in lib/voice/mic-flow.ts; this component
// only owns the two capture mechanisms and the pixels:
//   • recorder path — MediaRecorder → POST /api/ai/voice/transcribe (useVoice)
//   • on-device path — the Web Speech API (useSpeechRecognition), used when the
//     transcribe route answers 503 because no key is configured.
//
// SSR-safe by construction: both hooks report `supported: false` until an
// effect has run in the browser, and this renders NOTHING while that is the
// case. A server-rendered page therefore contains no mic — never a button that
// cannot record, which is the same honesty rule the rest of the app follows.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { useVoice, type VoiceErrorInfo } from '@/lib/hooks/use-voice';
import { useSpeechRecognition } from '@/lib/hooks/use-speech-recognition';
import {
  initialMicState, micAvailable, micErrorKey, micFlowStep, micLabelKey,
  type MicEffect, type MicEvent, type MicState, type MicStatus, type MicSupport,
} from '@/lib/voice/mic-flow';
import { useTranslations } from '@/components/i18n/locale-provider';
import { cn } from '@/lib/utils/cn';

export type MicButtonProps = {
  /** Called with the transcribed text — the only thing the mic produces. */
  onTranscript: (text: string) => void;
  /** The surface is busy (sending, or transcribing something else). */
  disabled?: boolean;
  /** `md` is the 44px target; `sm` still reaches 44px on a coarse pointer. */
  size?: 'sm' | 'md';
  className?: string;
  /** Surfaces with an error slot of their own show the message where it fits. */
  onError?: (message: string | null) => void;
  /** Lets a surface mirror the mic's state (the assistant's recording banner). */
  onStatusChange?: (status: MicStatus) => void;
};

export function MicButton({ onTranscript, disabled, size = 'md', className, onError, onStatusChange }: MicButtonProps) {
  const t = useTranslations();
  const [state, setState] = useState<MicState>(initialMicState);
  const stateRef = useRef<MicState>(initialMicState);

  // The last failure reported by useVoice. startRecording() resolves null for a
  // cancel AND for a failure; this is what tells the two apart.
  const failureRef = useRef<VoiceErrorInfo | null>(null);
  const voice = useVoice({ onError: (_msg, info) => { failureRef.current = info ?? { reason: 'capture' }; } });
  const speech = useSpeechRecognition();

  const support: MicSupport = { recorder: voice.supported, speech: speech.supported };
  const supportRef = useRef<MicSupport>(support);
  supportRef.current = support;
  const speechRef = useRef(speech);
  speechRef.current = speech;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  // Effects dispatch back into the machine, so the callback is reached through
  // a ref rather than a dependency cycle.
  const dispatchRef = useRef<(event: MicEvent) => void>(() => {});

  /** Read and clear the pending failure. A function, not a direct read: the
   *  ref is written by useVoice's callback while `record()` is awaiting. */
  const takeFailure = useCallback((): VoiceErrorInfo | null => {
    const failure = failureRef.current;
    failureRef.current = null;
    return failure;
  }, []);

  /** Record → transcribe, translating every outcome back into a machine event. */
  const record = useCallback(async () => {
    failureRef.current = null;
    const text = await voiceRef.current.startRecording();
    if (text !== null) { dispatchRef.current({ type: 'transcribed', text }); return; }
    const failure = takeFailure();
    // Null with no failure = the person cancelled; nothing went wrong.
    if (!failure) { dispatchRef.current({ type: 'cancel' }); return; }
    if (failure.reason === 'transcribe') {
      dispatchRef.current({ type: 'transcribe_failed', status: failure.status, support: supportRef.current });
      return;
    }
    dispatchRef.current({ type: 'capture_failed', reason: failure.reason === 'permission' ? 'permission' : 'capture_failed' });
  }, [takeFailure]);

  const runEffect = useCallback((effect: MicEffect) => {
    switch (effect.kind) {
      case 'start_recording': return void record();
      case 'stop_recording': return voiceRef.current.stopRecording();
      case 'start_listening': { speechRef.current.reset(); return speechRef.current.start(); }
      case 'stop_listening': return speechRef.current.stop();
      case 'submit': return onTranscriptRef.current(effect.text);
    }
  }, [record]);

  const dispatch = useCallback((event: MicEvent) => {
    const step = micFlowStep(stateRef.current, event);
    stateRef.current = step.state;
    setState(step.state);
    for (const effect of step.effects) runEffect(effect);
  }, [runEffect]);
  dispatchRef.current = dispatch;

  /** Abandon the capture — the stream stops, nothing is transcribed or sent. */
  const cancel = useCallback(() => {
    failureRef.current = null;
    if (stateRef.current.status === 'recording') voiceRef.current.cancelRecording();
    dispatch({ type: 'cancel' });
  }, [dispatch]);

  // Web Speech ends on its own after a pause; whatever it heard is the answer.
  useEffect(() => {
    if (stateRef.current.status !== 'listening') return;
    if (speech.error) { dispatch({ type: 'speech_failed' }); return; }
    if (!speech.listening && speech.transcript) dispatch({ type: 'speech_result', text: speech.transcript });
  }, [speech.listening, speech.error, speech.transcript, dispatch]);

  // Esc gets you out of a live mic, on every surface.
  const capturing = state.status === 'recording' || state.status === 'listening';
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capturing, cancel]);

  // Both notifications reach the surface through a ref, never through the
  // dependency array. A surface is free to pass an inline closure — the ⌘K bar
  // passes `onError={(m) => { if (m) toastError(m); }}` — which is a NEW
  // function on every render; showing the toast re-renders that surface, so a
  // callback dependency would re-fire this effect, push another toast, and loop
  // until React's "Maximum update depth exceeded" took the shell down. Only a
  // real change of status or error notifies. Same guard as onTranscriptRef.
  useEffect(() => { onStatusChangeRef.current?.(state.status); }, [state.status]);
  useEffect(() => { onErrorRef.current?.(state.error ? t(micErrorKey(state.error)) : null); }, [state.error, t]);

  // Nothing to render until the browser has said it can capture audio — which
  // is also what keeps the server-rendered markup mic-free.
  if (!micAvailable(support)) return null;

  const recording = state.status === 'recording';
  const listening = state.status === 'listening';
  const busy = state.status === 'transcribing';
  const label = t(micLabelKey(state));
  const box = size === 'sm' ? 'h-10 w-10' : 'h-11 w-11';

  return (
    <span className="relative inline-flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => dispatch({ type: 'press', support, transcript: speech.transcript })}
        disabled={disabled || busy}
        aria-label={label}
        title={label}
        aria-pressed={capturing}
        data-mic-status={state.status}
        className={cn(
          'relative grid place-items-center rounded-full border transition focus-ring disabled:opacity-40 coarse:min-h-11 coarse:min-w-11',
          box,
          capturing
            ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
            : 'border-border text-muted hover:bg-elevated hover:text-fg',
          className,
        )}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          : recording ? <Square className="h-4 w-4" aria-hidden />
            : <Mic className={size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden />}
        {capturing && <span className="absolute inset-0 animate-ping rounded-full border border-rose-400/60" aria-hidden />}
      </button>
      {/* Screen readers hear the state change even on surfaces with no banner. */}
      <span className="sr-only" role="status" aria-live="polite">
        {state.error ? t(micErrorKey(state.error))
          : recording ? t('micButton.recording')
            : listening ? t('micButton.listening')
              : busy ? t('micButton.transcribing') : ''}
      </span>
    </span>
  );
}
