import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/api/vacations/ai/route.ts', 'utf8');

describe('Vacation AI persistence boundaries', () => {
  it('fails closed when the trip or fan-out context cannot be read', () => {
    expect(source).toContain('tripError');
    expect(source).toContain('const contextError = contextResults.find((result) => result.error)?.error;');
    expect(source).toContain("return databaseUnavailable(t('ai.tripDataIsTemporarilyUnavailable'))");
  });

  it('checks recommendation replacement writes', () => {
    expect(source).toContain('const { error: deleteError }');
    expect(source).toContain('const { error: insertError }');
    expect(source).toContain("return databaseUnavailable(t('ai.recommendationsAreTemporarilyUnavailable'))");
  });

  it('checks generated row counts and rolls back tracked build writes', () => {
    expect(source).toContain('const createdActivityIds: string[] = [];');
    expect(source).toContain('const createdItemIds: string[] = [];');
    expect(source).toContain('const createdPackingItemIds: string[] = [];');
    expect(source).toContain('const rollbackBuild = async () =>');
    expect(source).toContain(".insert(rows).select('id')");
    expect(source).toContain('data.length !== rows.length');
    expect(source).toContain('await rollbackBuild();');
  });

  it('scopes existing conversations to the active family and vacation', () => {
    expect(source).toContain(".eq('family_id', familyId).eq('vacation_id', vacationId).maybeSingle()");
    expect(source).toContain("if (!conversation) return NextResponse.json({ error: t('ai.conversationNotFound') }, { status: 404 });");
    expect(source).toContain('const { error: userMessageError }');
    expect(source).toContain('const { error: assistantMessageError }');
  });
});
