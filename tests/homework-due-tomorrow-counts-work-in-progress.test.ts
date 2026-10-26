import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPEN_HOMEWORK_STATUSES, isOpen, type HomeworkStatus } from '@/lib/homework/board';
import { buildInsightCandidates } from '@/lib/home/insight-of-day';
import { bodyOf } from './helpers/source-order';

/**
 * "Homework due tomorrow" on the Moments page and on the home page's insight
 * of the day counted only `status = 'assigned'`. Work a child had STARTED
 * (`in_progress`) and not finished was due tomorrow all the same, and it is
 * the work most likely to be forgotten half-done — but it vanished from both
 * nudges the moment the child ticked it once. The Homework board, the school
 * service and the AI study plan all count `assigned` and `in_progress` as
 * still to do; the two nudges now read that same set, from one place.
 *
 * The home insight's copy said the work "hasn't been acknowledged yet", which
 * is not true of work in progress; it now says what is true of both.
 */

const ALL: HomeworkStatus[] = ['assigned', 'in_progress', 'done', 'submitted'];

describe('homework due tomorrow counts work in progress', () => {
  it('the open set is the one the Homework board calls open', () => {
    expect(OPEN_HOMEWORK_STATUSES).toEqual(['assigned', 'in_progress']);
    for (const status of ALL) {
      expect(isOpen({ id: 'x', due_at: null, status }), status).toBe(OPEN_HOMEWORK_STATUSES.includes(status));
    }
  });

  it.each([
    ['app/(app)/dashboard/moments/page.tsx', "supabase.from('homework_assignments')"],
    ['components/dashboard/ai-home-dashboard.tsx', "supabase.from('homework_assignments')"],
  ])('%s reads tomorrow\'s homework from the open set', (file, start) => {
    const read = bodyOf(readFileSync(file, 'utf8'), start, '),');
    expect(read).toContain(".in('status', OPEN_HOMEWORK_STATUSES)");
    expect(read).not.toContain(".eq('status', 'assigned')");
  });

  it('the AI study plan reads the same set', () => {
    const route = readFileSync('app/api/ai/insights/route.ts', 'utf8');
    expect(route).toContain("eq(sb, 'homework_assignments', familyId).in('status', OPEN_HOMEWORK_STATUSES)");
  });

  it('the home insight does not call started work unacknowledged', () => {
    const [one] = buildInsightCandidates({ homeworkDueTomorrow: [{ title: 'Volcano poster', who: 'Maya' }] });
    expect(one.kind).toBe('homework');
    expect(one.detail).not.toMatch(/acknowledged/);
    expect(one.detail).toContain('not finished');
    const [many] = buildInsightCandidates({ homeworkDueTomorrow: [{ title: 'A', who: 'Maya' }, { title: 'B', who: 'Leo' }] });
    expect(many.detail).not.toMatch(/acknowledged/);
    expect(many.detail).toContain('not finished');
  });
});
