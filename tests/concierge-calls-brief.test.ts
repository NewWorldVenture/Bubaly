import { describe, it, expect } from 'vitest';
import {
  buildCallBrief, callStatusTone, callSummary, CALL_TASK_LABEL, CALL_STATUS_LABEL,
} from '@/lib/concierge-calls/brief';

describe('buildCallBrief', () => {
  it('builds a complete plan for a booking with full details', () => {
    const b = buildCallBrief({
      taskKind: 'book',
      calleeName: 'Bright Smiles Dental',
      goal: 'book a cleaning for Emma',
      details: { familyName: 'Patel', memberName: 'Emma', preferredTimes: 'weekday mornings', referenceNumber: 'ACME-123' },
    });
    expect(b.opening).toContain('on behalf of the Patel family');
    expect(b.opening).toContain('for Emma');
    expect(b.keyPoints.some((k) => k.includes('ACME-123'))).toBe(true);
    expect(b.keyPoints.some((k) => k.includes('weekday mornings'))).toBe(true);
    // booking questions include a confirmation ask
    expect(b.questions.some((q) => /confirmation/i.test(q))).toBe(true);
    expect(b.successCriteria).toMatch(/confirmation/i);
    expect(b.fallback.length).toBeGreaterThan(0);
  });

  it('never throws with no details and still yields a valid plan', () => {
    const b = buildCallBrief({ taskKind: 'inquire', calleeName: 'City Clinic', goal: 'ask if they take our insurance' });
    expect(b.opening).toContain('a family');
    expect(b.keyPoints.length).toBeGreaterThan(0);
    expect(b.questions.length).toBeGreaterThan(0);
    // inquire/follow_up get the "clear answer" success criteria
    expect(b.successCriteria).toMatch(/clear|answer/i);
  });

  it('tailors questions per task kind', () => {
    expect(buildCallBrief({ taskKind: 'cancel', calleeName: 'X', goal: 'cancel' }).questions.some((q) => /cancellation/i.test(q))).toBe(true);
    expect(buildCallBrief({ taskKind: 'reschedule', calleeName: 'X', goal: 'move it' }).questions.some((q) => /available/i.test(q))).toBe(true);
    expect(buildCallBrief({ taskKind: 'confirm', calleeName: 'X', goal: 'still on?' }).questions.some((q) => /confirmed/i.test(q))).toBe(true);
  });

  it('always advises not to commit outside constraints (fallback)', () => {
    const b = buildCallBrief({ taskKind: 'book', calleeName: 'X', goal: 'y' });
    expect(b.fallback).toMatch(/do NOT commit|needing the family/i);
  });
});

describe('labels + helpers', () => {
  it('every task kind and status has a label', () => {
    expect(Object.keys(CALL_TASK_LABEL).length).toBe(7);
    expect(Object.keys(CALL_STATUS_LABEL).length).toBe(7);
  });
  it('status tone maps sensibly', () => {
    expect(callStatusTone('completed')).toBe('success');
    expect(callStatusTone('failed')).toBe('danger');
    expect(callStatusTone('action_needed')).toBe('warn');
    expect(callStatusTone('calling')).toBe('info');
    expect(callStatusTone('draft')).toBe('neutral');
  });
  it('callSummary is a compact one-liner', () => {
    expect(callSummary({ taskKind: 'book', calleeName: 'Dr. Lee', goal: 'x' })).toBe('Book an appointment · Dr. Lee');
  });
});
