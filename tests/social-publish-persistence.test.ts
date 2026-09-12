import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('social publishing persistence boundaries', () => {
  it('checks target account reads and target inserts before publishing', () => {
    const source = readFileSync('lib/social/publish.ts', 'utf8');

    expect(source).toContain("const { data: accounts, error: accountError } = await supabase");
    expect(source).toContain("throwPersistenceFailure('target account lookup failed', accountError)");
    expect(source).toContain(".is('deleted_at', null)");
    expect(source).toContain("const { error } = await supabase.from('social_post_targets').insert(rows)");
    expect(source).toContain("throwPersistenceFailure('target creation failed', error)");
  });

  it('records provider outcomes before updating target state and checks both writes', () => {
    const source = readFileSync('lib/social/publish.ts', 'utf8');

    expect(source).toContain("const { error: resultError } = await supabase.from('social_publish_results').insert({");
    expect(source).toContain("throw new Error(message)");
    expect(source).toContain("const { data: savedTarget, error: targetError } = await supabase");
    expect(source).toContain("'publish-result persistence failed'");
    expect(source).toContain("'target outcome persistence failed'");
  });

  it('cleans incomplete drafts and checks schedule persistence before success', () => {
    const source = readFileSync('app/(app)/dashboard/social/actions.ts', 'utf8');

    expect(source).toContain('async function cleanupPost(');
    expect(source).toContain("const { error: variantsError } = await supabase.from('social_post_variants').insert(variants)");
    expect(source).toContain("const { error: scheduleError } = await supabase.from('social_schedules').insert({");
    expect(source).toContain("const { data: calendarRows, error: calendarError } = await supabase.from('social_calendar_items').insert(calItems).select('id')");
    expect(source).toContain('if (postId && !publishStarted) await cleanupPost');
    expect(source).toContain('if (intent !== \'draft\' && accountIds.length === 0)');
  });

  it('sanitizes publish and retry failures for the client', () => {
    const source = readFileSync('app/(app)/dashboard/social/actions.ts', 'utf8');

    expect(source).toContain("import { describeActionError } from '@/lib/supabase/errors';");
    expect(source).toContain("const SOCIAL_SAVE_FAILURE = 'Social publishing could not be saved completely. Review the post status before retrying.'");
    expect(source).toContain("return { ok: false, postId, error: describeActionError(error, SOCIAL_SAVE_FAILURE) }");
  });

  it('keeps unexpected live-provider exceptions uncertain without exposing diagnostics', () => {
    const source = readFileSync('lib/social/connectors.ts', 'utf8');

    expect(source).toContain("errorCode: 'confirmation_unknown'");
    expect(source).toContain("status: 'publishing'");
    expect(source).toContain("errorMessage: t('socialX.publishUnknown')");
    expect(source).not.toContain('connector failed`, err');
    expect(source).not.toContain('errorMessage: err instanceof Error ? err.message');
  });
});
