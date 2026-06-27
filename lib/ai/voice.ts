// lib/ai/voice.ts — client-safe pure helpers for the voice assistant.
//
// Voice runs on OpenAI: speech-to-text (Whisper / gpt-4o-transcribe) for "talk
// to AI", and text-to-speech (gpt-4o-mini-tts / tts-1) for "AI speaks back".
// These helpers carry the deterministic, testable logic (mode rules, mime-type
// selection, text prep) so the UI and API routes stay thin.

/** How the assistant responds on THIS device. Device-local UX preference. */
export type VoiceMode = 'text' | 'voice' | 'both';

export const VOICE_MODES: { value: VoiceMode; label: string; hint: string }[] = [
  { value: 'text', label: 'Text only', hint: 'Read replies. No spoken audio.' },
  { value: 'both', label: 'Text + voice', hint: 'Read and hear replies.' },
  { value: 'voice', label: 'Voice first', hint: 'Hear replies spoken aloud.' },
];

export const DEFAULT_VOICE_MODE: VoiceMode = 'text';

/** OpenAI TTS voices (gpt-4o-mini-tts / tts-1 family). */
export const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: TtsVoice = 'nova';

/** Whether the assistant should speak its reply aloud in this mode. */
export function shouldSpeak(mode: VoiceMode): boolean {
  return mode === 'voice' || mode === 'both';
}

/** Whether the on-screen text bubble should render in this mode. (Always true —
 *  even "voice first" keeps a transcript for accessibility/scrollback.) */
export function shouldShowText(_mode: VoiceMode): boolean {
  return true;
}

/** Coerce an unknown stored value into a valid VoiceMode. */
export function normalizeVoiceMode(v: unknown): VoiceMode {
  return v === 'voice' || v === 'both' || v === 'text' ? v : DEFAULT_VOICE_MODE;
}

/** Coerce an unknown value into a valid TTS voice. */
export function normalizeTtsVoice(v: unknown): TtsVoice {
  return (TTS_VOICES as readonly string[]).includes(v as string) ? (v as TtsVoice) : DEFAULT_TTS_VOICE;
}

/**
 * Pick the best MediaRecorder mime type the browser supports, in preference
 * order. Returns '' to let the browser choose its default when none match
 * (e.g. some Safari versions). OpenAI's transcription accepts webm/mp4/mpeg/wav.
 */
export function pickRecordingMimeType(
  isSupported: (mime: string) => boolean = () => false,
): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const c of candidates) {
    try { if (isSupported(c)) return c; } catch { /* ignore */ }
  }
  return '';
}

/** Map a recording mime type to a sensible upload filename (OpenAI sniffs ext). */
export function filenameForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'speech.webm';
  if (m.includes('mp4') || m.includes('m4a')) return 'speech.mp4';
  if (m.includes('mpeg') || m.includes('mp3')) return 'speech.mp3';
  if (m.includes('ogg')) return 'speech.ogg';
  if (m.includes('wav')) return 'speech.wav';
  return 'speech.webm';
}

/** Clean a transcription before sending it on: trim, collapse whitespace. */
export function cleanTranscript(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Prepare assistant text for text-to-speech: strip markdown noise that sounds
 * bad read aloud (asterisks, backticks, link syntax, bullet markers) and cap
 * length so a long reply doesn't generate a multi-minute clip.
 */
export function prepareSpeechText(text: string, maxChars = 1200): string {
  let t = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')          // code fences
    .replace(/`([^`]+)`/g, '$1')               // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // bold
    .replace(/\*([^*]+)\*/g, '$1')             // italics
    .replace(/^#{1,6}\s+/gm, '')               // headings
    .replace(/^\s*[-*•]\s+/gm, '')             // bullets
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // markdown links → text
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > maxChars) {
    // Cut on a sentence boundary near the cap when possible.
    const slice = t.slice(0, maxChars);
    const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    t = lastStop > maxChars * 0.6 ? slice.slice(0, lastStop + 1) : slice + '…';
  }
  return t;
}

/** Server-side: validate an uploaded audio blob is a plausible recording. */
export function isValidAudioUpload(size: number, type: string, maxBytes = 25 * 1024 * 1024): { ok: true } | { ok: false; error: string } {
  if (!size) return { ok: false, error: 'Empty audio' };
  if (size > maxBytes) return { ok: false, error: 'Recording too large (max 25 MB)' };
  if (type && !/^audio\//i.test(type) && !/octet-stream/i.test(type)) {
    return { ok: false, error: 'Not an audio file' };
  }
  return { ok: true };
}
