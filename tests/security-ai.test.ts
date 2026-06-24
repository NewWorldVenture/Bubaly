import { describe, expect, it } from 'vitest';
import {
  analyzeSecurityEvents,
  buildSecurityPrompt,
  parseSecurityResponse,
  type SecurityEventLike,
} from '@/lib/home/security-ai';

function event(overrides: Partial<SecurityEventLike>): SecurityEventLike {
  return { kind: 'alert', severity: 'info', resolved: false, title: 'Test event', ...overrides };
}

describe('analyzeSecurityEvents', () => {
  it('summarizes events', () => {
    const r = analyzeSecurityEvents([
      event({ severity: 'critical', resolved: false }),
      event({ severity: 'warning', resolved: true }),
      event({ severity: 'info', resolved: false }),
    ]);
    expect(r.totalEvents).toBe(3);
    expect(r.openEvents).toBe(2);
    expect(r.criticalOpen).toBe(1);
    expect(r.allClear).toBe(false);
    expect(r.summary).toContain('2 open');
    expect(r.summary).toContain('1 critical');
  });

  it('detects all clear', () => {
    const r = analyzeSecurityEvents([event({ resolved: true })]);
    expect(r.allClear).toBe(true);
    expect(r.summary).toContain('all clear');
  });

  it('handles empty', () => {
    const r = analyzeSecurityEvents([]);
    expect(r.totalEvents).toBe(0);
    expect(r.allClear).toBe(true);
  });
});

describe('buildSecurityPrompt', () => {
  it('builds prompt with event info', () => {
    const { system, user } = buildSecurityPrompt([event({ kind: 'camera', severity: 'warning', title: 'Motion detected' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Motion detected');
    expect(user).toContain('camera');
  });
});

describe('parseSecurityResponse', () => {
  it('parses valid JSON', () => {
    const r = parseSecurityResponse('{"suggestions":["add cameras"],"priorities":["resolve critical"],"safetyTip":"test smoke alarms"}');
    expect(r.suggestions).toEqual(['add cameras']);
    expect(r.priorities).toEqual(['resolve critical']);
    expect(r.safetyTip).toBe('test smoke alarms');
  });

  it('handles malformed input', () => {
    const r = parseSecurityResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseSecurityResponse('```json\n{"suggestions":["x"],"priorities":[],"safetyTip":"y"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
