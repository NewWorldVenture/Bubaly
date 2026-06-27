import { describe, it, expect } from 'vitest';
import {
  routeCaptureHeuristic,
  resolveAiKey,
  availableDestinations,
  buildCapturePrompt,
  parseCaptureExtraction,
  canFile,
} from '@/lib/capture/routing';

describe('routeCaptureHeuristic', () => {
  it('routes shopping notes to Grocery', () => {
    expect(routeCaptureHeuristic('Buy milk and eggs', 2).key).toBe('grocery');
  });
  it('routes scheduling notes to Calendar', () => {
    expect(routeCaptureHeuristic('Dentist appointment Tuesday', 2).key).toBe('calendar');
  });
  it('falls back to the assistant with the query when nothing matches', () => {
    const r = routeCaptureHeuristic('xyzzy random musing', 2);
    expect(r.key).toBe('assistant');
    expect(r.url).toContain('/dashboard/assistant?q=');
  });

  it('never routes a Free user to a locked destination', () => {
    // "meal" maps to Meals (Basic-only); a Free user must not land there.
    const r = routeCaptureHeuristic('plan dinner meal', 0);
    expect(r.key).not.toBe('meals');
  });

  it('does route a Basic user to Meals', () => {
    expect(routeCaptureHeuristic('plan dinner meal', 1).key).toBe('meals');
  });
});

describe('resolveAiKey', () => {
  it('accepts a valid available key and normalizes noise', () => {
    expect(resolveAiKey('  Grocery.  ', 2, 'x')?.key).toBe('grocery');
  });
  it('rejects a locked key for the tier', () => {
    expect(resolveAiKey('tasks', 0, 'x')).toBeNull(); // tasks is Basic-only
  });
  it('rejects unknown keys', () => {
    expect(resolveAiKey('nonsense', 2, 'x')).toBeNull();
  });
});

describe('availableDestinations', () => {
  it('excludes Basic/Plus destinations for Free', () => {
    const keys = availableDestinations(0).map((d) => d.key);
    expect(keys).toContain('grocery');
    expect(keys).toContain('assistant');
    expect(keys).not.toContain('tasks');
    expect(keys).not.toContain('health');
  });
});

describe('buildCapturePrompt', () => {
  it('lists only tier-available destination keys', () => {
    const { user } = buildCapturePrompt('buy milk', 0);
    expect(user).toContain('grocery:');
    expect(user).not.toContain('tasks:');
  });
});

describe('parseCaptureExtraction', () => {
  it('parses key + title + ISO datetime from JSON', () => {
    const out = parseCaptureExtraction('{"key":"calendar","title":"Dentist","when":"2026-07-02T15:00:00Z"}', 2);
    expect(out?.key).toBe('calendar');
    expect(out?.title).toBe('Dentist');
    expect(out?.whenISO).toBe(new Date('2026-07-02T15:00:00Z').toISOString());
  });
  it('tolerates surrounding prose / code fences', () => {
    const out = parseCaptureExtraction('Here you go:\n```json\n{"key":"notes","title":"Idea","when":null}\n```', 2);
    expect(out?.key).toBe('notes');
    expect(out?.whenISO).toBeNull();
  });
  it('rejects a locked key for the tier', () => {
    expect(parseCaptureExtraction('{"key":"tasks","title":"x","when":null}', 0)).toBeNull();
  });
  it('nulls an invalid datetime', () => {
    expect(parseCaptureExtraction('{"key":"calendar","title":"x","when":"not a date"}', 2)?.whenISO).toBeNull();
  });
  it('returns null on non-JSON', () => {
    expect(parseCaptureExtraction('sorry I cannot', 2)).toBeNull();
  });
});

describe('canFile', () => {
  it('text destinations are always fileable', () => {
    expect(canFile('grocery', null)).toBe(true);
    expect(canFile('notes', null)).toBe(true);
  });
  it('calendar/reminders need a datetime', () => {
    expect(canFile('calendar', null)).toBe(false);
    expect(canFile('calendar', '2026-07-02T15:00:00Z')).toBe(true);
    expect(canFile('reminders', '2026-07-02T15:00:00Z')).toBe(true);
  });
  it('other destinations are not fileable', () => {
    expect(canFile('health', '2026-07-02T15:00:00Z')).toBe(false);
  });
});
