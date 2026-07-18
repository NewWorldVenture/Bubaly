import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/kids/page.tsx', 'utf8');

// PLA-0806: the child-facing dashboard's tasks, completed-points, and today's
// events are source-of-truth. If any read fails, it must fail closed rather
// than tell the child "All done! 🎉 No jobs left today." and "0 points earned"
// when they actually have chores and points — a reassuring-but-wrong,
// motivation-affecting lie. A genuinely missing table (unapplied migration) is
// still tolerated as empty; the dependent chore-title lookup stays best-effort.
describe('kids page read boundary', () => {
  it('collects the three source-of-truth read errors with a missing-table filter', () => {
    expect(page).toContain('const kidsError = [myTasksRes.error, doneRes.error, eventsRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a read failure', () => {
    expect(page).toContain('if (kidsError) {');
    expect(page).toContain("console.error('[kids] kids dashboard read failed', kidsError);");
    expect(page).toContain('return <ErrorState message="We couldn\'t load your day right now. Try again in a moment!" />;');
  });

  it('derives the kids data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (kidsError) {');
    const deriveIdx = page.indexOf('const myTasks = myTasksRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
