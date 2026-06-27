'use client';

// useSpeechRecognition — a thin, SSR-safe wrapper over the Web Speech API so any
// composer can offer "tap to speak". Returns the live transcript and controls;
// gracefully reports unsupported browsers instead of throwing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { appendTranscript, speechErrorMessage } from '@/lib/voice/transcript';

// Minimal typings for the (still non-standard) Web Speech API.
type SpeechRecognitionResult = { 0: { transcript: string }; isFinal: boolean };
type SpeechRecognitionEventLike = { results: ArrayLike<SpeechRecognitionResult>; resultIndex: number };
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type UseSpeechRecognition = {
  supported: boolean;
  listening: boolean;
  error: string | null;
  /** Final text accumulated this session. */
  transcript: string;
  start: () => void;
  stop: () => void;
  reset: () => void;
};

export function useSpeechRecognition(lang = 'en-US'): UseSpeechRecognition {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
    return () => { recRef.current?.abort(); };
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) { setError('Voice capture is not supported in this browser.'); return; }
    setError(null);
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) setTranscript((prev) => appendTranscript(prev, r[0].transcript));
      }
    };
    rec.onerror = (e) => setError(speechErrorMessage(e.error));
    rec.onend = () => setListening(false);
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch { /* already started */ }
  }, [lang]);

  const stop = useCallback(() => { recRef.current?.stop(); setListening(false); }, []);
  const reset = useCallback(() => { setTranscript(''); setError(null); }, []);

  return { supported, listening, error, transcript, start, stop, reset };
}
