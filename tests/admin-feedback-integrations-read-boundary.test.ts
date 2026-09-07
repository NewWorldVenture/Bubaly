import { readFileSync } from 'node:fs';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const feedback = readFileSync('app/(app)/admin/feedback/page.tsx', 'utf8');
const integrations = readFileSync('app/(app)/admin/integrations/page.tsx', 'utf8');

describe('admin feedback and integration read boundaries', () => {
  it('does not turn feedback queue failures into an empty board', () => {
    expect(feedback).toContain('ideasResult.error');
    expect(feedback).toContain('commentsResult.error');
    expect(feedback).toContain('notesResult.error');
    expectSays(feedback, 'feedback.couldNotLoadFeedbackFrom', 'Could not load feedback from Supabase. Refresh and try again.');
  });

  it('does not turn connected-account read failures into a not-configured status', () => {
    expect(integrations).toContain('googleCalendarResult.error');
    expect(integrations).toContain("console.error('[admin-integrations] connected-account read failed'");
    expectSays(integrations, 'integrations.couldNotLoadConnectedAccount', 'Could not load connected-account status from Supabase. Refresh and try again.');
  });
});
