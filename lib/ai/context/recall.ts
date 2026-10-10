// Recalled facts for a context slice, behind the "Allow memory" switch.
//
// The memory slice honours the switch; schedule, shopping and travel called
// `recallFacts` directly and put confirmed facts ("Preference:", "Habit:")
// in front of the model for a family that had turned memory off. Every slice
// other than `memory` reads facts through here instead.
//
// The settings read is STRICT and fails closed: a failed read yields no facts
// (the slice still loads its own module's rows), never the forgiving default
// that would answer a timeout with memory ON (SEC-009).
import 'server-only';
import { loadAISettings } from '@/lib/services/ai-settings';
import { recallFacts, type FamilyFact, type RecallInput } from '@/lib/services/memory';
import { ok, type ServiceResult, type ServiceScope } from '@/lib/services/types';

export async function recallFactsForContext(scope: ServiceScope, input: RecallInput = {}): Promise<ServiceResult<FamilyFact[]>> {
  const settings = await loadAISettings(scope);
  if (!settings.ok) {
    console.error('[ai-context] memory setting unreadable; leaving remembered facts out', settings.error);
    return ok([]);
  }
  if (!settings.data.memoryEnabled) return ok([]);
  return recallFacts(scope, input);
}
