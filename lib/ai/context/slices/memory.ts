// What the family has told Bubaly to remember (§14): confirmed facts, pinned
// first, each marked as typed by a person or learned by Bubaly so the planner
// can weigh them (§2: differentiate confirmed facts from inferred ones). The
// medical and account categories are shown to managers only; anyone else
// gets preferences, dates, sizes and the like. Unconfirmed suggestions are
// listed for managers with an explicit "not a fact" label — a planner may
// ask about them, never act on them.
import 'server-only';
import { fenceUntrusted } from '@/lib/ai/safety/untrusted';
import { FACT_CATEGORY_LABELS, type FactCategory } from '@/lib/memory/facts';
import { isAiFact, isSensitiveMemory, listMemories } from '@/lib/services/memory';
import { getAISettings } from '@/lib/services/ai-settings';
import { ok } from '@/lib/services/types';
import { memberName, type SliceDefinition } from '../policy';

const MAX_FACTS = 60;
const MAX_PENDING = 5;

export type MemorySliceData = {
  facts: { id: string; category: string; label: string; value: string; member: string | null; pinned: boolean; source: 'person' | 'bubaly' }[];
  pending: { id: string; category: string; label: string; value: string; confidence: number }[];
  /** How many confirmed facts were withheld from this viewer by category policy. */
  withheld: number;
};

function categoryLabel(category: string): string {
  return (FACT_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

export const memorySlice: SliceDefinition = {
  name: 'memory',
  title: 'What Bubaly remembers',
  async load(scope, env) {
    // "Allow memory" off means Bubaly does not use what it learned next time —
    // the other half of the promise the toggle makes. The facts stay in the
    // family's own module; they just do not reach the model.
    const settings = await getAISettings(scope);
    if (!settings.memoryEnabled) {
      return ok({
        data: { facts: [], pending: [], withheld: 0 } satisfies MemorySliceData,
        count: 0,
        lines: ['- This family has asked Bubaly not to use what it remembers.'],
      });
    }

    const memories = await listMemories(scope);
    if (!memories.ok) return memories;
    const canManage = env.viewer.canManage;

    const visible = memories.data.facts.filter((f) => canManage || !isSensitiveMemory({ category: f.category, key: f.label, content: f.value }));
    const data: MemorySliceData = {
      facts: visible.slice(0, MAX_FACTS).map((f) => ({
        id: f.id, category: f.category, label: f.label, value: f.value, member: memberName(env, f.member_id), pinned: f.is_pinned,
        source: isAiFact(f) ? 'bubaly' : 'person',
      })),
      pending: canManage
        ? memories.data.pending.slice(0, MAX_PENDING).map((s) => ({ id: s.id, category: s.category, label: s.label, value: s.value, confidence: s.confidence }))
        : [],
      withheld: memories.data.facts.length - visible.length,
    };

    const lines: string[] = [];
    for (const f of data.facts) {
      const bits = [`- ${f.pinned ? '★ ' : ''}[${categoryLabel(f.category as FactCategory)}] ${fenceUntrusted('fact', `${f.label}: ${f.value}`)}`];
      if (f.member) bits.push(`(about ${f.member})`);
      if (f.source === 'bubaly') bits.push('(learned by Bubaly, confirmed)');
      lines.push(bits.join(' '));
    }
    if (!data.facts.length) lines.push('- Nothing remembered yet beyond what the other sections show.');
    for (const s of data.pending) {
      lines.push(`- Unconfirmed guess (not a fact, do not rely on it): ${fenceUntrusted('suggestion', `${s.label}: ${s.value}`)}`);
    }

    return ok({ data, count: data.facts.length + data.pending.length, lines });
  },
};
