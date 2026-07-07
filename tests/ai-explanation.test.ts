import { describe, it, expect } from 'vitest';
import {
  explainAutopilot,
  explainInsight,
  explainAgentActivity,
  explainConsensus,
  confidenceNarrative,
} from '@/lib/ai/explanation';

describe('confidenceNarrative', () => {
  it('tiers on the autopilot thresholds', () => {
    expect(confidenceNarrative(95).label).toMatch(/auto-handle/i);
    expect(confidenceNarrative(75).label).toMatch(/quick OK|worth doing/i);
    expect(confidenceNarrative(40).label).toMatch(/awareness/i);
  });
  it('boundary values 90 and 70 round up to the higher tier', () => {
    expect(confidenceNarrative(90).label).toMatch(/auto-handle/i);
    expect(confidenceNarrative(70).label).toMatch(/worth doing/i);
    expect(confidenceNarrative(69).label).toMatch(/awareness/i);
  });
});

describe('explainAutopilot', () => {
  it('surfaces signal, confidence, urgency and the proposed action', () => {
    const e = explainAutopilot({
      kind: 'groceries', title: 'Reorder milk', detail: 'You buy milk weekly and it is due.',
      confidence: 92, urgency: 2, source_kind: 'grocery_items', action_label: 'Reorder milk',
    });
    expect(e.reason).toMatch(/milk weekly/i);
    expect(e.confidence).toBe(92);
    const labels = e.factors.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['Signal', 'Confidence', 'Urgency', 'Proposed action']));
    expect(e.factors.find((f) => f.label === 'Signal')?.detail).toMatch(/grocery list/i);
    expect(e.factors.find((f) => f.label === 'Confidence')?.value).toMatch(/92%/);
    expect(e.tip).toMatch(/automatically/i);
  });

  it('falls back to a generated reason and humanizes unknown kinds/sources', () => {
    const e = explainAutopilot({ kind: 'custom_thing', title: 'X', confidence: 55 });
    expect(e.reason).toMatch(/Custom Thing/i);
    expect(e.factors.find((f) => f.label === 'Urgency')?.value).toBe('low');
    expect(e.factors.some((f) => f.label === 'Proposed action')).toBe(false);
    expect(e.tip).toMatch(/awareness/i);
  });
});

describe('explainInsight', () => {
  it('explains why this insight won the single slot', () => {
    const e = explainInsight({ kind: 'conflict', title: 'A clash', detail: 'Double-booked.', impact: 90, alternatives: 3 });
    expect(e.reason).toBe('Double-booked.');
    const byLabel = Object.fromEntries(e.factors.map((f) => [f.label, f.value]));
    expect(byLabel['Type']).toMatch(/Schedule clash/i);
    expect(byLabel['Priority']).toBe('90/100 impact');
    expect(byLabel['Chosen over']).toMatch(/3 other signals/);
  });
  it('omits the "chosen over" factor when there are no alternatives', () => {
    const e = explainInsight({ kind: 'grocery', title: 'Buy', impact: 34, alternatives: 0 });
    expect(e.factors.some((f) => f.label === 'Chosen over')).toBe(false);
    expect(e.reason).toMatch(/time-sensitive/i); // fallback
  });
});

describe('explainAgentActivity', () => {
  it('names the agent and type', () => {
    const e = explainAgentActivity({ agent: 'scheduler', kind: 'recommendation', title: 'Move soccer', detail: 'Overlaps piano.', severity: 'attention' });
    expect(e.reason).toBe('Overlaps piano.');
    const byLabel = Object.fromEntries(e.factors.map((f) => [f.label, f.value]));
    expect(byLabel['Agent']).toBe('Scheduler');
    expect(byLabel['Type']).toBe('Recommendation');
    expect(byLabel['Priority']).toBe('Attention');
    expect(e.tip).toMatch(/Scheduler agent/);
  });
});

describe('explainConsensus', () => {
  it('reports votes, blended fit, agreement and budget', () => {
    const e = explainConsensus({
      label: 'Trattoria', rationale: '3 votes · within budget.', votes: 3, votePct: 60,
      blendedScore: 82, totalVotes: 5, consensusLevel: 0.6, budgetCents: 8000,
    });
    const byLabel = Object.fromEntries(e.factors.map((f) => [f.label, f.value]));
    expect(byLabel['Votes']).toBe('3 (60% of 5)');
    expect(byLabel['Overall fit']).toMatch(/82\/100/);
    expect(byLabel['Family agreement']).toMatch(/Strong Agreement/i);
    expect(byLabel['Budget checked']).toBe('$80 cap');
  });
  it('omits budget when not provided and reports a split vote', () => {
    const e = explainConsensus({ label: 'A', rationale: '', votes: 2, votePct: 40, blendedScore: 50, totalVotes: 5, consensusLevel: 0.3 });
    expect(e.factors.some((f) => f.label === 'Budget checked')).toBe(false);
    expect(e.factors.find((f) => f.label === 'Family agreement')?.value).toMatch(/Split Vote/i);
    expect(e.reason).toMatch(/best balances/i); // fallback
  });
});
