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
export function useVoice(opts: { onError?: (msg: string) => void } = {}) {
  const onError = opts.onError;
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [mode, setModeState] = useState<VoiceMode>(DEFAULT_VOICE_MODE);
  const [voice, setVoiceState] = useState<TtsVoice>(DEFAULT_TTS_VOICE);
  const [supported, setSupported] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
      onError?.('Voice input isn’t supported on this browser.');
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
          if (!res.ok) { onError?.(data.error ?? 'Could not transcribe that.'); resolveRef.current?.(null); }
          else resolveRef.current?.(data.text ?? null);
        } catch {
          onError?.('Could not transcribe that. Please try again.');
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
      onError?.(denied ? 'Microphone access was denied. Enable it in your browser settings.' : 'Could not start recording.');
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
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; audioRef.current = null; }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setStatus((s) => (s === 'speaking' ? 'idle' : s));
  }, []);

  /** Speak the given text aloud via OpenAI TTS, falling back to the browser
   *  speech synthesizer if the server route is unavailable. */
  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    stopSpeaking();
    setStatus('speaking');
    try {
      const res = await fetch('/api/ai/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => { URL.revokeObjectURL(url); setStatus((s) => (s === 'speaking' ? 'idle' : s)); };
        audio.onerror = () => { URL.revokeObjectURL(url); setStatus((s) => (s === 'speaking' ? 'idle' : s)); };
        await audio.play();
        return;
      }
      // 503/502 → try the browser's built-in synthesizer as a graceful fallback.
      throw new Error('tts unavailable');
    } catch {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => setStatus((s) => (s === 'speaking' ? 'idle' : s));
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
