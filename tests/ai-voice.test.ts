import { describe, expect, it } from 'vitest';
import {
  VOICE_MODES, TTS_VOICES, DEFAULT_VOICE_MODE, DEFAULT_TTS_VOICE,
  shouldSpeak, shouldShowText, normalizeVoiceMode, normalizeTtsVoice,
  pickRecordingMimeType, filenameForMime, cleanTranscript,
  prepareSpeechText, isValidAudioUpload,
} from '@/lib/ai/voice';

describe('voice mode rules', () => {
  it('exposes three modes with text as default', () => {
    expect(VOICE_MODES.map((m) => m.value)).toEqual(['text', 'both', 'voice']);
    expect(DEFAULT_VOICE_MODE).toBe('text');
  });
  it('speaks only in voice/both', () => {
    expect(shouldSpeak('text')).toBe(false);
    expect(shouldSpeak('both')).toBe(true);
    expect(shouldSpeak('voice')).toBe(true);
  });
  it('always keeps a text transcript for accessibility', () => {
    expect(shouldShowText('voice')).toBe(true);
    expect(shouldShowText('text')).toBe(true);
  });
});

describe('normalizers', () => {
  it('coerces unknown voice modes to the default', () => {
    expect(normalizeVoiceMode('voice')).toBe('voice');
    expect(normalizeVoiceMode('both')).toBe('both');
    expect(normalizeVoiceMode('garbage')).toBe('text');
    expect(normalizeVoiceMode(null)).toBe('text');
  });
  it('coerces unknown tts voices to the default', () => {
    expect(normalizeTtsVoice('shimmer')).toBe('shimmer');
    expect(normalizeTtsVoice('robot')).toBe(DEFAULT_TTS_VOICE);
    expect(TTS_VOICES).toContain(DEFAULT_TTS_VOICE);
  });
});

describe('pickRecordingMimeType', () => {
  it('prefers opus webm when supported', () => {
    expect(pickRecordingMimeType((m) => m === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
  });
  it('falls back to mp4 (Safari) when webm is unsupported', () => {
    expect(pickRecordingMimeType((m) => m === 'audio/mp4')).toBe('audio/mp4');
  });
  it('returns empty string when nothing is supported', () => {
    expect(pickRecordingMimeType(() => false)).toBe('');
  });
  it('never throws if the support probe throws', () => {
    expect(pickRecordingMimeType(() => { throw new Error('x'); })).toBe('');
  });
});

describe('filenameForMime', () => {
  it('maps mime types to extensions OpenAI can sniff', () => {
    expect(filenameForMime('audio/webm;codecs=opus')).toBe('speech.webm');
    expect(filenameForMime('audio/mp4')).toBe('speech.mp4');
    expect(filenameForMime('audio/mpeg')).toBe('speech.mp3');
    expect(filenameForMime('audio/ogg')).toBe('speech.ogg');
    expect(filenameForMime('unknown')).toBe('speech.webm');
  });
});

describe('cleanTranscript', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanTranscript('  hello   there \n world ')).toBe('hello there world');
  });
});

describe('prepareSpeechText', () => {
  it('strips markdown that sounds bad aloud', () => {
    const out = prepareSpeechText('# Heading\n**Bold** and *italic* and `code`\n- bullet');
    expect(out).not.toContain('*');
    expect(out).not.toContain('`');
    expect(out).not.toContain('#');
    expect(out).toContain('Bold');
    expect(out).toContain('bullet');
  });
  it('resolves markdown links to their text', () => {
    expect(prepareSpeechText('See [the calendar](https://x.com/c)')).toBe('See the calendar');
  });
  it('caps very long text', () => {
    const long = 'This is a sentence. '.repeat(200);
    const out = prepareSpeechText(long, 200);
    expect(out.length).toBeLessThanOrEqual(201);
  });
});

describe('isValidAudioUpload', () => {
  it('rejects empty audio', () => {
    expect(isValidAudioUpload(0, 'audio/webm').ok).toBe(false);
  });
  it('rejects oversized audio', () => {
    expect(isValidAudioUpload(30 * 1024 * 1024, 'audio/webm').ok).toBe(false);
  });
  it('rejects non-audio types', () => {
    expect(isValidAudioUpload(100, 'image/png').ok).toBe(false);
  });
  it('accepts a normal webm recording', () => {
    expect(isValidAudioUpload(50_000, 'audio/webm;codecs=opus').ok).toBe(true);
  });
  it('accepts octet-stream (some browsers omit the audio type)', () => {
    expect(isValidAudioUpload(50_000, 'application/octet-stream').ok).toBe(true);
  });
});
