import { describe, it, expect } from 'vitest';
import { stripWakeWords, classifyVoiceCommand, describeRoute } from '@/lib/voice/command-router';

// Fixed "now" so time-based parsing (parseEvent) is deterministic.
const NOW = new Date('2026-07-04T09:00:00');

describe('stripWakeWords', () => {
  it('peels leading wake words and politeness (repeatedly)', () => {
    expect(stripWakeWords('Hey Bubaly, add milk')).toBe('add milk');
    expect(stripWakeWords('okay please remind me to call')).toBe('remind me to call');
    expect(stripWakeWords('Can you note that the wifi is down')).toBe('note that the wifi is down');
  });
  it('returns empty when the text is only a wake word', () => {
    expect(stripWakeWords('Bubaly')).toBe('');
    expect(stripWakeWords('  ok  ')).toBe('');
  });
  it('leaves a plain command untouched', () => {
    expect(stripWakeWords('buy eggs')).toBe('buy eggs');
  });
});

describe('classifyVoiceCommand', () => {
  it('routes explicit shopping phrasing and cleans both ends', () => {
    const r = classifyVoiceCommand('Hey Bubaly, add milk and eggs to the shopping list', NOW);
    expect(r.kind).toBe('shopping');
    expect(r.explicit).toBe(true);
    expect(r.text).toBe('Milk and eggs');
  });
  it('routes a bare "add X" to shopping', () => {
    const r = classifyVoiceCommand('add batteries', NOW);
    expect(r.kind).toBe('shopping');
    expect(r.text).toBe('Batteries');
  });
  it('routes "remind me to…" to a task and strips the verb', () => {
    const r = classifyVoiceCommand('remind me to pay the water bill', NOW);
    expect(r.kind).toBe('task');
    expect(r.text).toBe('Pay the water bill');
  });
  it('routes "note that…" to a note', () => {
    const r = classifyVoiceCommand('note that the garage code is 1234', NOW);
    expect(r.kind).toBe('note');
    expect(r.text).toBe('The garage code is 1234');
  });
  it('routes "schedule…" to an event', () => {
    const r = classifyVoiceCommand('schedule parent teacher conference', NOW);
    expect(r.kind).toBe('event');
  });
  it('respects a concrete time as an event even with a shopping-ish verb', () => {
    const r = classifyVoiceCommand('add dentist tomorrow at 3pm', NOW);
    expect(r.kind).toBe('event');
    expect(r.explicit).toBe(false);
  });
  it('falls back to the shared heuristic for unmarked text', () => {
    // Plain statement → task default from suggestKind.
    expect(classifyVoiceCommand('water the plants', NOW).kind).toBe('task');
  });
  it('handles empty / wake-only input safely', () => {
    const r = classifyVoiceCommand('Bubaly', NOW);
    expect(r.text).toBe('');
  });
});

describe('describeRoute', () => {
  it('gives a friendly past-tense label per kind', () => {
    expect(describeRoute('task')).toBe('Added task');
    expect(describeRoute('note')).toBe('Saved note');
    expect(describeRoute('event')).toBe('Scheduled event');
    expect(describeRoute('shopping')).toBe('Added to shopping list');
  });
});
