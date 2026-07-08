import { describe, it, expect } from 'vitest';
import { answerFamilyQuestions, reasoningSummary, type ReasoningEngineInput } from '@/lib/reasoning/engine';
import type { OrchestratorReport } from '@/lib/operating-index/orchestrator';
import type { ReasoningInsight } from '@/lib/reasoning/insights';

const NOW = new Date('2026-07-08T12:00:00.000Z');

function orch(overrides: Partial<Record<string, { status: 'clear' | 'attention'; items: { label: string; href?: string }[] }>> = {}): OrchestratorReport {
  const ids = ['go_wrong', 'auto_today', 'overloaded', 'decide_next', 'missing_info'] as const;
  return {
    answers: ids.map((id) => ({
      id, question: id, status: overrides[id]?.status ?? 'clear',
      headline: '', items: overrides[id]?.items ?? [],
    })),
    allClear: false, generatedAt: NOW.toISOString(),
  };
}

describe('answerFamilyQuestions', () => {
  it('always answers all six questions in order', () => {
    const r = answerFamilyQuestions({}, NOW);
    expect(r.answers.map((a) => a.id)).toEqual(['matters_most', 'forgotten', 'decide_next', 'auto_complete', 'who_needs_help', 'what_next']);
  });

  it('reads fully calm with no inputs', () => {
    const r = answerFamilyQuestions({}, NOW);
    expect(r.allClear).toBe(true);
    expect(r.answers.every((a) => a.status === 'clear' && a.items.length === 0)).toBe(true);
  });

  it('routes orchestrator answers to the right questions', () => {
    const input: ReasoningEngineInput = {
      orchestrator: orch({
        decide_next: { status: 'attention', items: [{ label: 'Pick a camp', href: '/dashboard/decisions' }] },
        auto_today: { status: 'attention', items: [{ label: 'Reorder milk' }] },
        overloaded: { status: 'attention', items: [{ label: 'Mia has 9 things' }] },
        missing_info: { status: 'attention', items: [{ label: 'Recital has no location' }] },
      }),
    };
    const r = answerFamilyQuestions(input, NOW);
    const by = (id: string) => r.answers.find((a) => a.id === id)!;
    expect(by('decide_next').items[0].title).toBe('Pick a camp');
    expect(by('auto_complete').items[0].title).toBe('Reorder milk');
    expect(by('who_needs_help').status).toBe('attention');
    expect(by('forgotten').items[0].title).toContain('Recital');
    expect(r.allClear).toBe(false);
  });

  it('folds high-score signals + insights into "matters most"', () => {
    const signals = [{ kind: 'chore_conflict', title: 'Dishes cause friction', score: 80 }];
    const insights: ReasoningInsight[] = [{ id: 'i1', kind: 'ripple', title: 'Soccer touches 6 things', detail: '', href: '/dashboard/graph', severity: 'action' }];
    const r = answerFamilyQuestions({ signals, insights }, NOW);
    const mm = r.answers.find((a) => a.id === 'matters_most')!;
    expect(mm.status).toBe('attention');
    const titles = mm.items.map((i) => i.title);
    expect(titles).toContain('Dishes cause friction'); // score 80 ≥ 60
    expect(titles).toContain('Soccer touches 6 things'); // action severity
  });

  it('puts ignored-reminder signals under "forgotten" and stress windows under "who needs help"', () => {
    const r = answerFamilyQuestions({
      signals: [
        { kind: 'ignored_reminder', title: 'Trash keeps getting missed', score: 70 },
        { kind: 'stress_window', title: 'Weekday evenings are crunch time', score: 65 },
      ],
    }, NOW);
    expect(r.answers.find((a) => a.id === 'forgotten')!.items.some((i) => i.title.includes('Trash'))).toBe(true);
    expect(r.answers.find((a) => a.id === 'who_needs_help')!.items.some((i) => i.title.includes('crunch'))).toBe(true);
  });

  it('ranks next actions by priority and caps each answer at 4', () => {
    const nextActions = Array.from({ length: 7 }, (_, i) => ({ title: `Action ${i}`, priority: i * 10 }));
    const r = answerFamilyQuestions({ nextActions }, NOW);
    const wn = r.answers.find((a) => a.id === 'what_next')!;
    expect(wn.items).toHaveLength(4);
    expect(wn.items[0].title).toBe('Action 6'); // highest priority first
  });

  it('de-dupes identical titles within an answer', () => {
    const r = answerFamilyQuestions({
      orchestrator: orch({ go_wrong: { status: 'attention', items: [{ label: 'Clash tomorrow' }] } }),
      signals: [{ kind: 'x', title: 'Clash tomorrow', score: 90 }],
    }, NOW);
    const mm = r.answers.find((a) => a.id === 'matters_most')!;
    expect(mm.items.filter((i) => i.title === 'Clash tomorrow')).toHaveLength(1);
  });
});

describe('reasoningSummary', () => {
  it('summarizes every answer for persistence', () => {
    const s = reasoningSummary(answerFamilyQuestions({ nextActions: [{ title: 'X', priority: 5 }] }, NOW));
    expect(s.allClear).toBe(false);
    expect(Array.isArray(s.answers)).toBe(true);
    expect((s.answers as unknown[]).length).toBe(6);
  });
});
