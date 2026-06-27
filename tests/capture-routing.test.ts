import { describe, it, expect } from 'vitest';
import {
  routeCaptureHeuristic,
  resolveAiKey,
  availableDestinations,
  buildCapturePrompt,
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
