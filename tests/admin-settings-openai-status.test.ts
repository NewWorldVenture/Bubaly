import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/settings/page.tsx', 'utf8');

// The admin Settings page must surface the *live* OpenAI status (the model and
// key source the app actually resolves at runtime), not just a bare env-presence
// check — and it must not regress into the mojibake it previously carried.
//
// It used to "degrade to the env signal" when the AI config read failed, but
// getAIConfigView dropped a RESOLVED error, so the `.catch(() => null)` here
// never ran and the row read "OPENAI_API_KEY not set" over a stored key. A
// failed read is Unavailable now, never the env signal (review
// R9-AI-CONFIG-VIEW-FAILED-READ-IS-A-VALUE). The rendered page is driven in
// tests/a-failed-ai-config-read-is-not-a-value.test.ts; these name the mechanism.
describe('admin settings OpenAI status', () => {
  it('resolves the live AI config view instead of only reading the env flag', () => {
    expect(page).toContain("import { getAIConfigView } from '@/lib/ai/settings';");
    expect(page).toContain('const { view: ai, error: aiError } = await getAIConfigView(supabase);');
    expect(page).toContain("{ name: 'OpenAI (AI)', ready: openaiReady, detail: openaiDetail }");
    expect(page).not.toContain('getAIConfigView(supabase).catch(');
  });

  it('shows the resolved model and key source, and a failed read as Unavailable rather than the env signal', () => {
    expect(page).toContain('const openaiReady: boolean | null = ai ? ai.openaiKeySet : null;');
    expect(page).toContain("key from ${ai.openaiFromEnv ? 'env (OPENAI_API_KEY)' : 'admin console'}");
    expect(page).toContain("{ label: 'AI provider', value: 'OpenAI' }");
    expect(page).toContain("{ label: 'AI model', value: ai ? ai.model ?? 'default' : unavailable }");
    expect(page).not.toContain('!!process.env.OPENAI_API_KEY');
    expect(page).not.toContain('process.env.AI_MODEL');
  });

  it('carries no mojibake / corrupted UTF-8 (title + em-dashes)', () => {
    expect(page).toContain("title: 'Admin · Settings'");
    expect(page).not.toContain('Â·');
    expect(page).not.toContain('â€”');
  });
});
