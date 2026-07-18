import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/settings/page.tsx', 'utf8');

// The admin Settings page must surface the *live* OpenAI status (the model and
// key source the app actually resolves at runtime), not just a bare env-presence
// check — and it must not regress into the mojibake it previously carried.
describe('admin settings OpenAI status', () => {
  it('resolves the live AI config view instead of only reading the env flag', () => {
    expect(page).toContain("import { getAIConfigView } from '@/lib/ai/settings';");
    expect(page).toContain('const ai = await getAIConfigView(supabase).catch(() => null);');
    expect(page).toContain("{ name: 'OpenAI (AI)', ready: openaiReady, detail: openaiDetail }");
  });

  it('shows the resolved model and key source, degrading to the env signal', () => {
    expect(page).toContain('const openaiReady = ai ? ai.openaiKeySet : !!process.env.OPENAI_API_KEY;');
    expect(page).toContain("key from ${openaiFromEnv ? 'env (OPENAI_API_KEY)' : 'admin console'}");
    expect(page).toContain("{ label: 'AI provider', value: 'OpenAI' }");
    expect(page).toContain("{ label: 'AI model', value: ai?.model ?? process.env.AI_MODEL ?? 'default' }");
  });

  it('carries no mojibake / corrupted UTF-8 (title + em-dashes)', () => {
    expect(page).toContain("title: 'Admin · Settings'");
    expect(page).not.toContain('Â·');
    expect(page).not.toContain('â€”');
  });
});
