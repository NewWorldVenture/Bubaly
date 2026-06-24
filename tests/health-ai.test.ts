import { describe, expect, it } from 'vitest';
import { analyzeHealth, buildHealthPrompt, parseHealthResponse, type HealthMetricForAI, type WorkoutForAI } from '@/lib/health/health-ai';

function metric(overrides: Partial<HealthMetricForAI> = {}): HealthMetricForAI {
  return { type: 'steps', value: 8000, recorded_at: '2025-06-20T08:00:00Z', ...overrides };
}

function workout(overrides: Partial<WorkoutForAI> = {}): WorkoutForAI {
  return { activity: 'Running', duration_minutes: 30, calories: 250, recorded_at: '2025-06-20T07:00:00Z', ...overrides };
}

describe('analyzeHealth', () => {
  it('summarizes health data', () => {
    const r = analyzeHealth([metric(), metric({ type: 'heart_rate', value: 72 })], [workout()], 2);
    expect(r.totalMetrics).toBe(2);
    expect(r.totalWorkouts).toBe(1);
    expect(r.totalGoals).toBe(2);
  });
  it('handles empty', () => { expect(analyzeHealth([], [], 0).summary).toContain('No health'); });
});

describe('buildHealthPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildHealthPrompt([metric()], [workout()]);
    expect(system).toContain('JSON');
    expect(user).toContain('steps');
  });
});

describe('parseHealthResponse', () => {
  it('parses valid JSON', () => {
    const r = parseHealthResponse('{"suggestions":["aim for 10k steps"],"wellnessTips":["drink more water"],"motivationTip":"Every step counts!"}');
    expect(r.suggestions).toEqual(['aim for 10k steps']);
  });
  it('handles malformed', () => { expect(parseHealthResponse('bad').suggestions).toEqual([]); });
});
