// lib/voice/transcript.ts — pure helpers for the Voice Capture feature.
// The Web Speech API hook does the listening; these functions clean and merge
// the recognized text so the logic is unit-testable without a microphone.

/** Tidy a recognized chunk: collapse whitespace, trim, sentence-case the start. */
export function cleanTranscript(raw: string): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Append a freshly recognized chunk to existing text with sensible spacing —
 * adds a space between words, but not before punctuation, and not duplicating
 * the trailing space. Returns the combined text.
 */
export function appendTranscript(existing: string, chunk: string): string {
  const add = (chunk ?? '').replace(/\s+/g, ' ').trim();
  if (!add) return existing;
  const base = existing ?? '';
  if (!base) return cleanTranscript(add);
  const needsSpace = !base.endsWith(' ') && !/^[.,!?;:]/.test(add);
  return base + (needsSpace ? ' ' : '') + add;
}

/** Map a SpeechRecognition error code to a friendly, actionable message. */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked. Enable it in your browser settings.';
    case 'no-speech':
      return "Didn't catch that — try speaking again.";
    case 'audio-capture':
      return 'No microphone found. Check your device.';
    case 'network':
      return 'Network issue with speech recognition. Try again.';
    default:
      return 'Voice capture had a problem. Try again.';
  }
}
