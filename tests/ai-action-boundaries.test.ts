import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const provider = readFileSync('lib/ai/provider.ts', 'utf8');
const chatRoute = readFileSync('app/api/ai/chat/route.ts', 'utf8');
const adminActions = readFileSync('app/(app)/admin/ai/actions.ts', 'utf8');

describe('AI action boundaries', () => {
  it('does not return raw tool or admin configuration failures', () => {
    expect(provider).toContain('toolExecutionFailure');
    expect(provider).toContain('describeActionError');
    expect(provider).not.toContain('error: e instanceof Error ? e.message');
    expect(adminActions).toContain('describeActionError');
    expect(adminActions).not.toContain('error: e instanceof Error ? e.message');
  });

  it('fails closed when assistant initialization or family context reads fail', () => {
    expect(chatRoute).toContain('conversationUpsertError');
    expect(chatRoute).toContain('contextError');
    expect(chatRoute).toContain('historyError');
    expect(chatRoute).toContain('membersError');
    expect(chatRoute).toContain('eventsError');
    expect(chatRoute).toContain('choresError');
    expect(chatRoute).toContain('mealsError');
  });

  it('checks conversation persistence before reporting completion', () => {
    expect(chatRoute).toContain('messageInsertError');
    expect(chatRoute).toContain('titleReadError');
    expect(chatRoute).toContain('titleUpdateError');
    expect(chatRoute).toContain('persisted: !persistenceError');
  });
});
