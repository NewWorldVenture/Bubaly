import { describe, it, expect } from 'vitest';
import { cleanTranscript, appendTranscript, speechErrorMessage } from '@/lib/voice/transcript';

describe('cleanTranscript', () => {
  it('collapses whitespace, trims, and capitalizes', () => {
    expect(cleanTranscript('  hello   world ')).toBe('Hello world');
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript(undefined as unknown as string)).toBe('');
  });
});

describe('appendTranscript', () => {
  it('joins chunks with a single space', () => {
    expect(appendTranscript('Hello', 'world')).toBe('Hello world');
  });
  it('does not add a space before punctuation', () => {
    expect(appendTranscript('Hello', ', friend')).toBe('Hello, friend');
  });
  it('seeds from empty and capitalizes the first chunk', () => {
    expect(appendTranscript('', 'today was good')).toBe('Today was good');
  });
  it('ignores empty chunks', () => {
    expect(appendTranscript('Hello', '   ')).toBe('Hello');
  });
  it('does not double a trailing space', () => {
    expect(appendTranscript('Hello ', 'there')).toBe('Hello there');
  });
});

describe('speechErrorMessage', () => {
  it('maps known codes to friendly messages', () => {
    expect(speechErrorMessage('not-allowed')).toMatch(/Microphone access/);
    expect(speechErrorMessage('no-speech')).toMatch(/catch that/);
    expect(speechErrorMessage('audio-capture')).toMatch(/No microphone/);
    expect(speechErrorMessage('weird')).toMatch(/problem/);
  });
});
