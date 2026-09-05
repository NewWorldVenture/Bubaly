// "Needs Your Attention" (§16) merges Bubaly's own asks — pending AI
// approvals, runs parked on a person, and level-1 recommendations — into the
// same ranked queue as the household's money approvals and renewals. The one
// rule worth a test on its own: an approval that gates a run and that run's
// "waiting for your OK" line are ONE decision and must appear once.
import { describe, expect, it } from 'vitest';
import { buildHomeNeeds, type HomeNeedsInput } from '@/lib/home/needs-build';
import { aiApprovalToNeed, awaitingRunToNeed, recommendationToNeed } from '@/lib/home/needs-sources';
import { rankNeedsAttention } from '@/lib/home/needs-attention';

const base: HomeNeedsInput = {
  approvals: [], renewals: [], documents: [], conflicts: [],
  pendingApprovals: 0, overdueMeds: false, overdueReminders: 0, dueTodayReminders: 0,
  pendingChores: 0, lowGrocery: false, openTodos: 0, now: new Date('2026-09-05T12:00:00Z'),
};

describe('buildHomeNeeds with Bubaly asks', () => {
  it('still returns nothing when the new sources are absent or empty', () => {
    expect(buildHomeNeeds(base)).toEqual([]);
    expect(buildHomeNeeds({ ...base, aiApprovals: [], awaitingRuns: [], recommendations: [] })).toEqual([]);
  });

  it('adds AI approvals, parked runs and recommendations with their own kinds', () => {
    const out = buildHomeNeeds({
      ...base,
      aiApprovals: [{ id: 'ap-1', title: 'Add soccer practice Saturday 9:00', runId: null, requestedAt: '2026-09-05T11:00:00Z' }],
      awaitingRuns: [
        { id: 'run-1', summary: 'Plan our week', state: 'awaiting_context', updated_at: '2026-09-05T10:00:00Z' },
        { id: 'run-2', summary: 'Prepare beach vacation', state: 'executing', updated_at: '2026-09-05T10:30:00Z' },
      ],
      recommendations: [{ id: 'rec-1', title: 'Move dentist to Thursday', priority: 'medium', cta_href: null, created_at: '2026-09-04T09:00:00Z' }],
    });
    expect(out.map((n) => n.kind)).toEqual(['ai_approval', 'run_awaiting_answer', 'recommendation']);
    expect(out.find((n) => n.kind === 'run_awaiting_answer')?.href).toBe('/dashboard/concierge/runs/run-1');
    // An executing run needs nobody.
    expect(out.find((n) => n.id === 'run:run-2')).toBeUndefined();
  });

  it('shows an approval that gates a run once, as the approval card, never twice', () => {
    const out = buildHomeNeeds({
      ...base,
      aiApprovals: [{ id: 'ap-1', title: 'Book the plumber for Tuesday', runId: 'run-9', requestedAt: '2026-09-05T11:00:00Z' }],
      awaitingRuns: [{ id: 'run-9', summary: 'Find a plumber', state: 'awaiting_approval', updated_at: '2026-09-05T11:00:00Z' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('ai_approval');
    expect(out[0].href).toBe('/dashboard/concierge/runs/run-9');
  });

  it('keeps a parked run visible when no approval row points at it', () => {
    const out = buildHomeNeeds({
      ...base,
      aiApprovals: [{ id: 'ap-2', title: 'Something else', runId: 'run-other', requestedAt: '2026-09-05T11:00:00Z' }],
      awaitingRuns: [{ id: 'run-9', summary: 'Find a plumber', state: 'awaiting_approval', updated_at: '2026-09-05T11:00:00Z' }],
    });
    expect(out.map((n) => n.kind).sort()).toEqual(['ai_approval', 'run_awaiting_approval']);
  });

  it('ranks Bubaly asks with the household ones: urgent decisions first, then by recency', () => {
    const ranked = rankNeedsAttention(buildHomeNeeds({
      ...base,
      approvals: [{ id: 'm1', kind: 'card_spend', amount_cents: 1200, created_at: '2026-09-05T09:00:00Z' }],
      aiApprovals: [{ id: 'ap-1', title: 'Add soccer', runId: null, requestedAt: '2026-09-05T11:30:00Z' }],
      recommendations: [{ id: 'rec-1', title: 'Try a new dinner', created_at: '2026-09-05T11:45:00Z' }],
      openTodos: 3,
    }));
    // Count-based signals are stamped `now`, so among the normal-urgency items
    // the open to-dos line is newer than a recommendation made earlier today.
    expect(ranked.map((n) => n.kind)).toEqual(['ai_approval', 'approval', 'todos', 'recommendation']);
  });
});

describe('needs-sources mappers', () => {
  it('escalates a high-priority AI approval to emergency and links to the trust inbox without a run', () => {
    const n = aiApprovalToNeed({ id: 'a', title: 'Pay the $400 invoice', runId: null, priority: 'high', requestedAt: '2026-09-05T11:00:00Z' });
    expect(n.urgency).toBe('emergency');
    expect(n.href).toBe('/dashboard/trust');
  });

  it('describes what a parked run is waiting on', () => {
    expect(awaitingRunToNeed({ id: 'r', summary: 'Plan meals', state: 'awaiting_approval', updated_at: 'x' })?.title).toBe('Plan meals — waiting for your OK');
    expect(awaitingRunToNeed({ id: 'r', summary: '', state: 'awaiting_context', updated_at: 'x' })?.title).toBe('A request from your family — Bubaly has a question');
    expect(awaitingRunToNeed({ id: 'r', summary: 'x', state: 'completed', updated_at: 'x' })).toBeNull();
  });

  it('routes a recommendation to its CTA and treats high priority as urgent', () => {
    const n = recommendationToNeed({ id: 'x', title: 'Renew passports', priority: 'high', cta_href: '/dashboard/documents', created_at: 'x' });
    expect(n.urgency).toBe('urgent');
    expect(n.href).toBe('/dashboard/documents');
    expect(recommendationToNeed({ id: 'y', title: 'T', created_at: 'x' }).href).toBe('/dashboard/autonomous-family-management');
  });
});
