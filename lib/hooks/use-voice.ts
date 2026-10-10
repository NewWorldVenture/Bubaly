'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type VoiceMode, type TtsVoice,
  DEFAULT_VOICE_MODE, DEFAULT_TTS_VOICE,
  normalizeVoiceMode, normalizeTtsVoice,
  pickRecordingMimeType, filenameForMime, shouldSpeak,
} from '@/lib/ai/voice';

const MODE_KEY = 'ai-voice-mode';
const VOICE_KEY = 'ai-voice-name';

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'speaking';

/**
 * Why a voice attempt failed, alongside the message. The shared MicButton needs
 * the SHAPE of the failure, not its prose: a 503 from the transcribe route is
 * "voice isn't configured here" and must fall back to on-device recognition,
 * while a denied permission must not. Callers that only want the message keep
 * working — the second argument is optional.
 */
export type VoiceErrorInfo = {
  reason: 'unsupported' | 'permission' | 'capture' | 'transcribe';
  /** HTTP status of the transcribe response, when there was one. */
  status?: number;
};

/** True when this browser can record microphone audio. */
export function voiceInputSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined';
}

/**
 * Voice assistant hook: microphone recording + OpenAI transcription, plus
 * text-to-speech playback of assistant replies. Mode and voice are persisted
 * per-device in localStorage (voice output is genuinely a device-level choice —
 * you don't want your phone speaking because you toggled it on a laptop).
 */
export function useVoice(opts: { onError?: (msg: string, info?: VoiceErrorInfo) => void } = {}) {
  const onError = opts.onError;
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [mode, setModeState] = useState<VoiceMode>(DEFAULT_VOICE_MODE);
  const [voice, setVoiceState] = useState<TtsVoice>(DEFAULT_TTS_VOICE);
  const [supported, setSupported] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechRequestRef = useRef<AbortController | null>(null);
  const speechUrlRef = useRef<string | null>(null);
  const resolveRef = useRef<((text: string | null) => void) | null>(null);

  useEffect(() => {
    setSupported(voiceInputSupported());
    try {
      setModeState(normalizeVoiceMode(localStorage.getItem(MODE_KEY)));
      setVoiceState(normalizeTtsVoice(localStorage.getItem(VOICE_KEY)));
    } catch { /* ignore */ }
  }, []);

  const setMode = useCallback((m: VoiceMode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  }, []);

  const setVoice = useCallback((v: TtsVoice) => {
    setVoiceState(v);
    try { localStorage.setItem(VOICE_KEY, v); } catch { /* ignore */ }
  }, []);

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  /** Begin recording. Resolves the returned promise with transcribed text
   *  (or null on cancel/failure) once stopRecording() is called. */
  const startRecording = useCallback(async (): Promise<string | null> => {
    if (!voiceInputSupported()) {
      onError?.('Voice input isn’t supported on this browser.', { reason: 'unsupported' });
      return null;
    }
    if (status === 'recording') return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickRecordingMimeType((m) => window.MediaRecorder.isTypeSupported(m));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        cleanupStream();
        if (blob.size === 0) { setStatus('idle'); resolveRef.current?.(null); resolveRef.current = null; return; }
        setStatus('transcribing');
        try {
          const fd = new FormData();
          fd.append('audio', blob, filenameForMime(recorder.mimeType || 'audio/webm'));
          const res = await fetch('/api/ai/voice/transcribe', { method: 'POST', body: fd });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { onError?.(data.error ?? 'Could not transcribe that.', { reason: 'transcribe', status: res.status }); resolveRef.current?.(null); }
          else resolveRef.current?.(data.text ?? null);
        } catch {
          onError?.('Could not transcribe that. Please try again.', { reason: 'transcribe' });
          resolveRef.current?.(null);
        } finally {
          setStatus('idle');
          resolveRef.current = null;
        }
      };

      const promise = new Promise<string | null>((resolve) => { resolveRef.current = resolve; });
      recorder.start();
      setStatus('recording');
      return promise;
    } catch (e) {
      cleanupStream();
      setStatus('idle');
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError');
      onError?.(
        denied ? 'Microphone access was denied. Enable it in your browser settings.' : 'Could not start recording.',
        { reason: denied ? 'permission' : 'capture' },
      );
      return null;
    }
  }, [status, onError, cleanupStream]);

  /** Stop the active recording; the startRecording() promise resolves with text. */
  const stopRecording = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') r.stop();
  }, []);

  /** Cancel recording without transcribing. */
  const cancelRecording = useCallback(() => {
    const r = recorderRef.current;
    resolveRef.current?.(null);
    resolveRef.current = null;
    chunksRef.current = [];
    if (r && r.state !== 'inactive') { r.onstop = null; r.stop(); }
    cleanupStream();
    setStatus('idle');
  }, [cleanupStream]);

  /** Stop any in-progress speech playback. */
  const stopSpeaking = useCallback(() => {
    speechRequestRef.current?.abort();
    speechRequestRef.current = null;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; audioRef.current = null; }
    if (speechUrlRef.current) { URL.revokeObjectURL(speechUrlRef.current); speechUrlRef.current = null; }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setStatus((s) => (s === 'speaking' ? 'idle' : s));
  }, []);

  /** Speak the given text aloud via OpenAI TTS, falling back to the browser
   *  speech synthesizer if the server route is unavailable. `exchangeId` is
   *  the assistant turn's request id: speaking that turn is part of the same,
   *  already-counted exchange (F19), so the server does not count it again. */
  const speak = useCallback(async (text: string, exchangeId?: string | null) => {
    if (!text.trim()) return;
    stopSpeaking();
    const request = new AbortController();
    speechRequestRef.current = request;
    const current = () => speechRequestRef.current === request && !request.signal.aborted;
    setStatus('speaking');
    try {
      const res = await fetch('/api/ai/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, ...(exchangeId ? { exchangeId } : {}) }),
        signal: request.signal,
      });
      if (!current()) return;
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (!current()) return;
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
        speechUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        const finished = () => {
          URL.revokeObjectURL(url);
          if (speechUrlRef.current === url) speechUrlRef.current = null;
          if (current()) setStatus((s) => (s === 'speaking' ? 'idle' : s));
        };
        audio.onended = finished;
        audio.onerror = finished;
        await audio.play();
        return;
      }
      // 503/502 → try the browser's built-in synthesizer as a graceful fallback.
      throw new Error('tts unavailable');
    } catch {
      if (!current()) return;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => { if (current()) setStatus((s) => (s === 'speaking' ? 'idle' : s)); };
        window.speechSynthesis.speak(u);
      } else {
        setStatus((s) => (s === 'speaking' ? 'idle' : s));
      }
    }
  }, [voice, stopSpeaking]);

  // Stop audio when the component unmounts.
  useEffect(() => () => { stopSpeaking(); cleanupStream(); }, [stopSpeaking, cleanupStream]);

  return {
    status, mode, setMode, voice, setVoice, supported,
    startRecording, stopRecording, cancelRecording,
    speak, stopSpeaking, shouldSpeak: () => shouldSpeak(mode),
  };
}
