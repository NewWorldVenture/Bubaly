import { describe, it, expect } from 'vitest';
import {
  median, summarizeJourneys, formatDuration, formatRate, journeyLabel,
  type JourneyEventLike,
} from '@/lib/analytics/journey';

const ev = (over: Partial<JourneyEventLike> & { journey: string; phase: string; session_id: string }): JourneyEventLike => ({
  step: 0, duration_ms: null, created_at: '2026-07-04T00:00:00Z', ...over,
});

describe('median', () => {
  it('odd, even, and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 2])).toBe(3);
    expect(median([])).toBeNull();
    expect(median([10])).toBe(10);
  });
});

describe('summarizeJourneys', () => {
  it('counts starts, distinct completed sessions, rate, and medians', () => {
    const events: JourneyEventLike[] = [
      ev({ journey: 'capture', phase: 'started', session_id: 's1' }),
      ev({ journey: 'capture', phase: 'completed', session_id: 's1', duration_ms: 4000, step: 2 }),
      ev({ journey: 'capture', phase: 'started', session_id: 's2' }),
      ev({ journey: 'capture', phase: 'completed', session_id: 's2', duration_ms: 8000, step: 4 }),
      ev({ journey: 'capture', phase: 'started', session_id: 's3' }), // abandoned (no completed)
      ev({ journey: 'add_memory', phase: 'started', session_id: 'm1' }),
    ];
    const s = summarizeJourneys(events);
    const cap = s.find((x) => x.journey === 'capture')!;
    expect(cap.starts).toBe(3);
    expect(cap.completions).toBe(2);
    expect(cap.completionRate).toBeCloseTo(2 / 3);
    expect(cap.medianDurationMs).toBe(6000); // median of 4000, 8000
    expect(cap.medianSteps).toBe(3);          // median of 2, 4
    expect(cap.label).toBe('Capture a thought');

    const mem = s.find((x) => x.journey === 'add_memory')!;
    expect(mem.starts).toBe(1);
    expect(mem.completions).toBe(0);
    expect(mem.completionRate).toBe(0);
    expect(mem.medianDurationMs).toBeNull();
  });

  it('dedupes duplicate completed events by session (rate never exceeds 100%)', () => {
    const events: JourneyEventLike[] = [
      ev({ journey: 'x', phase: 'started', session_id: 's1' }),
      ev({ journey: 'x', phase: 'completed', session_id: 's1', duration_ms: 1000 }),
      ev({ journey: 'x', phase: 'completed', session_id: 's1', duration_ms: 1000 }), // dup
    ];
    const [row] = summarizeJourneys(events);
    expect(row.completions).toBe(1);
    expect(row.completionRate).toBe(1);
  });

  it('sorts by starts desc', () => {
    const events: JourneyEventLike[] = [
      ev({ journey: 'a', phase: 'started', session_id: '1' }),
      ev({ journey: 'b', phase: 'started', session_id: '2' }),
      ev({ journey: 'b', phase: 'started', session_id: '3' }),
    ];
    expect(summarizeJourneys(events).map((r) => r.journey)).toEqual(['b', 'a']);
  });
});

describe('formatters', () => {
  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(3200)).toBe('3.2s');
    expect(formatDuration(65000)).toBe('1m 05s');
  });
  it('formatRate', () => {
    expect(formatRate(0.723)).toBe('72%');
    expect(formatRate(1)).toBe('100%');
  });
  it('journeyLabel falls back to the key', () => {
    expect(journeyLabel('capture')).toBe('Capture a thought');
    expect(journeyLabel('unknown_x')).toBe('unknown_x');
  });
});
