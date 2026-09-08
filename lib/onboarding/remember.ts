// lib/onboarding/remember.ts — writing the onboarding answers into family memory.
//
// The mapping is pure (`./facts`); this is the thin server half that respects
// the family's memory switch and reports what it did. Two rules it keeps:
//
//   * "Allow memory" (Settings → Bubaly AI) wins. `rememberFact` only consults
//     that setting for sources Bubaly itself produced, and these are written as
//     'user' facts — a person typed them — so the check has to happen HERE or a
//     family that switched memory off would still be remembered from. Switching
//     it off is a request not to be, whoever did the typing.
//   * Never block onboarding. A memory that does not get written is a smaller
//     failure than a wizard that will not finish, so every failure is logged and
//     counted rather than thrown; the caller finishes regardless.

import 'server-only';
import { getAISettings } from '@/lib/services/ai-settings';
import { rememberFact } from '@/lib/services/memory';
import type { ServiceScope } from '@/lib/services/types';
import { ONBOARDING_FACT_NOTE, ONBOARDING_FACT_SOURCE, onboardingFacts, type OnboardingAnswers } from './facts';

export type RememberOnboardingResult = {
  /** Facts written or updated in `family_facts`. */
  written: number;
  /** Facts that were derived but could not be written (each one is logged). */
  failed: number;
  /** True when the family has memory switched off, so nothing was attempted. */
  memoryDisabled: boolean;
};

export async function rememberOnboardingFacts(
  scope: ServiceScope,
  answers: OnboardingAnswers,
): Promise<RememberOnboardingResult> {
  const facts = onboardingFacts(answers);
  if (facts.length === 0) return { written: 0, failed: 0, memoryDisabled: false };

  const settings = await getAISettings(scope);
  if (!settings.memoryEnabled) return { written: 0, failed: 0, memoryDisabled: true };

  let written = 0;
  let failed = 0;
  for (const fact of facts) {
    const res = await rememberFact(scope, {
      category: fact.category,
      key: fact.key,
      content: fact.content,
      source: ONBOARDING_FACT_SOURCE,
      // No `confidence`: the confirmed lane stores none, and null there means
      // "nobody had to guess", which is exactly true of a typed answer.
      note: ONBOARDING_FACT_NOTE,
    });
    if (res.ok) written++;
    else {
      failed++;
      console.error('[onboarding] remembering an answer failed', { key: fact.key, error: res.error });
    }
  }
  return { written, failed, memoryDisabled: false };
}
