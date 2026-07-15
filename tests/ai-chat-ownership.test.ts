import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/api/ai/chat/route.ts', 'utf8');

describe('AI chat conversation ownership', () => {
  it('rechecks client-supplied conversation IDs against family and user ownership', () => {
    expect(source).toContain(".select('id').eq('id', conversationId).eq('family_id', familyId).eq('user_id', ctx.user.id).maybeSingle()");
    expect(source).toContain('const { data: conversation, error: conversationReadError }');
    expect(source).toContain("return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });");
  });

  it('does not expose history or persist messages when the ownership check fails', () => {
    const ownershipBlock = source.slice(source.indexOf('const { data: conversation, error: conversationReadError }'), source.indexOf('// Conversation history'));
    expect(ownershipBlock).toContain("return NextResponse.json({ error: 'Could not open this conversation.' }, { status: 503 });");
    expect(ownershipBlock).toContain("return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });");
    expect(ownershipBlock).not.toContain("from('ai_messages')");
  });
});
