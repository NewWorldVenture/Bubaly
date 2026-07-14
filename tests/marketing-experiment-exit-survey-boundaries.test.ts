import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const experiments = readFileSync('app/(app)/admin/marketing/experiments/actions.ts', 'utf8');
const exitIntent = readFileSync('app/(app)/admin/marketing/exit-intent/actions.ts', 'utf8');
const surveys = readFileSync('app/(app)/admin/marketing/surveys/actions.ts', 'utf8');

describe('marketing experiment, exit-intent, and survey boundaries', () => {
  it('checks experiment writes, targets, and configured winners', () => {
    expect(experiments).toContain('marketingActionFailure');
    expect(experiments).toContain('hasConfiguredVariant');
    expect(experiments).toContain(".select('id').maybeSingle()");
    expect(experiments).toContain(".select('variants')");
    expect(experiments).not.toContain("return { ok: false, error: error.message }");
  });

  it('checks exit-intent inserts and soft-delete targets', () => {
    expect(exitIntent).toContain('marketingActionFailure');
    expect(exitIntent).toContain(".select('id').maybeSingle()");
    expect(exitIntent).not.toContain("const { data } = await supabase.from('marketing_exit_intent').insert");
  });

  it('checks survey status and deletion targets', () => {
    expect(surveys).toContain('marketingActionFailure');
    expect(surveys).toContain(".select('id').maybeSingle()");
    expect(surveys).not.toContain("const { error } = await supabase.from('surveys').update");
  });
});
