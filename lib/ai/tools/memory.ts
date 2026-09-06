// Memory tools: what the assistant may remember, recall and forget.
//
// THE POLICY (spec §14): `memory.remember` is for an explicit instruction —
// "remember that Tom doesn't eat mushrooms" — and writes a confirmed fact.
// Anything the assistant merely infers must go through the service with an
// AI source so it lands in the review inbox unconfirmed; the tool carries a
// `source` argument for that, defaulting to the explicit case. Medical and
// account details are refused outright whichever source is claimed: those
// live in the health and accounts modules where a person enters them on
// purpose, and the refusal says so rather than silently dropping the fact.
//
// WHY THE TRUST DOMAIN IS `tasks`: `TRUST_DOMAINS` has no household-knowledge
// domain, and inventing one would mean editing an enum every stored policy is
// written against. The roster tools in `family.ts` made the same call for the
// same reason. Memory writes are therefore governed by the family's Tasks
// autonomy setting — the least surprising of the existing dials, and one that
// "recommend only" households have deliberately turned down.
import 'server-only';
import { z } from 'zod';
import { FACT_CATEGORY_LABELS } from '@/lib/memory/facts';
import {
  forgetFact, isAiFact, isSensitiveMemory, recallFacts, rememberFact, type FamilyFact,
} from '@/lib/services/memory';
import { getAISettings } from '@/lib/services/ai-settings';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { resolveAssigneeId } from './family';
import { defineTool, plural, type ToolDefinition } from './types';

const CATEGORIES = ['about', 'preference', 'contact', 'sizes', 'important', 'date', 'other'] as const;

const SENSITIVE_REFUSAL = 'Medical and account details are only saved when a person enters them directly — allergies belong in the health profile, and account details in the accounts vault.';

const factOutput = z.object({
  id: z.string(),
  category: z.string(),
  label: z.string(),
  value: z.string(),
  member_id: z.string().nullable(),
  pinned: z.boolean(),
  /** False for a fact Bubaly learned and a person confirmed; true for one a person entered. */
  from_person: z.boolean(),
  /** When this stops being true; null for a fact with no shelf life. */
  expires_at: z.string().nullable(),
});

function toFactOutput(fact: FamilyFact) {
  return {
    id: fact.id,
    category: fact.category,
    label: fact.label,
    value: fact.value,
    member_id: fact.member_id,
    pinned: fact.is_pinned,
    // 0265: provenance is a column. This read a prefix in the notes text,
    // which an ordinary edit to that note silently rewrote.
    from_person: !isAiFact(fact),
    expires_at: fact.expires_at,
  };
}

export const memoryTools: ToolDefinition[] = [
  defineTool({
    name: 'memory.remember',
    aliases: ['remember_fact', 'save_family_fact', 'remember'],
    description: 'Remember a durable household fact or preference so it is used in future planning. Not for medical or account details.',
    domain: 'tasks',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      key: z.string().describe('What the fact is about, e.g. "Doesn\'t eat", "Shoe size", "Go-to dinner"'),
      content: z.string().describe('The fact itself, e.g. "mushrooms", "US 3", "Taco night"'),
      category: z.enum(CATEGORIES).nullish().describe('Defaults to "preference" for likes/dislikes, otherwise "other"'),
      member: z.string().nullish().describe('Family member the fact is about; omit for the whole family'),
      member_id: z.string().nullish(),
      asked_for: z.boolean().nullish().describe('True ONLY when the person asked in so many words to remember this ("remember that…", "note that…"). Anything you worked out yourself is not asked for.'),
      confidence: z.number().int().nullish().describe('0–100, how sure you are — used when this is your own inference'),
      note: z.string().nullish().describe('Context or evidence'),
      expires_at: z.string().nullish().describe('Date after which this stops being true, as YYYY-MM-DD (or a full ISO datetime WITH a Z or ±HH:MM offset — a time with no zone is refused, because when a fact expires must not depend on which server wrote it). Use it for anything that will go stale on its own — a clothing size, a school year, a policy term. Omit for a fact that simply is.'),
    }),
    output: z.object({
      kind: z.enum(['fact', 'suggestion']),
      id: z.string(),
      label: z.string(),
      value: z.string(),
      member_id: z.string().nullable(),
      confirmed: z.boolean(),
      updated: z.boolean(),
    }),
    idempotencyFrom: (input) => {
      const key = input.key.trim().toLowerCase();
      return key ? `memory.remember:${input.member_id ?? input.member ?? ''}:${key}:${input.content.trim().toLowerCase()}` : null;
    },
    summarize: (_input, output) => (output.confirmed
      ? `${output.updated ? 'Updated' : 'Remembered'}: ${output.label} — ${output.value}`
      : `Noted ${output.label} — ${output.value}, waiting for someone to confirm it`),
    resource: (output) => ({ table: output.kind === 'fact' ? 'family_facts' : 'family_playbook_suggestions', id: output.id }),
    execute: async (scope, input) => {
      const key = input.key.trim();
      const content = input.content.trim();
      if (!key || !content) return fail('A memory needs both a label and the thing to remember.', { code: SERVICE_CODES.invalidInput });
      if (isSensitiveMemory({ category: input.category ?? null, key, content })) {
        return fail(SENSITIVE_REFUSAL, { code: SERVICE_CODES.denied });
      }

      const member = await resolveAssigneeId(scope, { assignee_id: input.member_id, assignee: input.member });
      if (!member.ok) return member;

      const category = input.category ?? (/dislike|doesn'?t eat|favou?rite|go-to|likes?|loves?|diet|prefers?/i.test(`${key} ${content}`) ? 'preference' : 'other');
      // The lane a memory lands in used to be `input.source ?? 'user'` — the
      // model's own word for whether its inference was a fact, defaulting to
      // "a person said so". So everything Bubaly worked out went in confirmed,
      // and §2's "differentiate confirmed facts from inferred ones" was decided
      // by the party with the least standing to decide it.
      //
      // A person asking in so many words is still the confirmed lane, because
      // that is genuinely what happened and the model can see it in the turn.
      // Silence is not consent: anything else is an inference, and inferences
      // go to the review inbox where somebody can say yes.
      const res = await rememberFact(scope, {
        category,
        key,
        content,
        source: input.asked_for === true ? 'user' : 'ai_conversation',
        confidence: input.confidence ?? null,
        memberId: member.data,
        note: input.note ?? null,
        expiresAt: input.expires_at ?? null,
      });
      if (!res.ok) return res;
      if (res.data.kind === 'fact') {
        const fact = res.data.fact;
        return ok({ kind: 'fact' as const, id: fact.id, label: fact.label, value: fact.value, member_id: fact.member_id, confirmed: true, updated: res.data.updated });
      }
      const s = res.data.suggestion;
      return ok({ kind: 'suggestion' as const, id: s.id, label: s.label, value: s.value, member_id: s.member_id, confirmed: false, updated: res.data.duplicate });
    },
    verify: async (scope, _input, output) => {
      const table = output.kind === 'fact' ? 'family_facts' : 'family_playbook_suggestions';
      const { data, error } = await scope.db.from(table).select('id').eq('family_id', scope.familyId).eq('id', output.id).maybeSingle();
      if (error) {
        console.error('[tool:memory.remember] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the memory was saved.'), { code: SERVICE_CODES.db });
      }
      const found = Boolean(data);
      return ok({ verified: found, detail: found ? `"${output.label}" is saved.` : 'The memory was not saved.' });
    },
  }),

  defineTool({
    name: 'memory.recall',
    aliases: ['recall_facts', 'search_family_facts', 'get_family_facts'],
    description: 'Look up what the family has asked Bubaly to remember: preferences, sizes, contacts, dates and notes.',
    domain: 'tasks',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      query: z.string().nullish().describe('Words to match against the label, value or notes'),
      category: z.enum(['about', 'preference', 'medical', 'contact', 'sizes', 'important', 'account', 'date', 'other']).nullish(),
      member: z.string().nullish(),
      member_id: z.string().nullish(),
      limit: z.number().int().nullish(),
    }),
    output: z.object({ facts: z.array(factOutput) }),
    summarize: (input, output) => (output.facts.length === 0
      ? `Nothing remembered${input.query ? ` about "${input.query}"` : ''}`
      : `Recalled ${plural(output.facts.length, 'fact')}${input.query ? ` about "${input.query}"` : ''}`),
    execute: async (scope, input) => {
      // The other half of "Allow memory": off means Bubaly does not use what it
      // remembers, whether it arrives through the context slice or by asking.
      const settings = await getAISettings(scope);
      if (!settings.memoryEnabled) return ok({ facts: [] });

      const member = await resolveAssigneeId(scope, { assignee_id: input.member_id, assignee: input.member });
      if (!member.ok) return member;
      const res = await recallFacts(scope, {
        query: input.query ?? null,
        category: input.category ?? null,
        memberId: member.data,
        limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      // The category labels are the ones the knowledge page shows; a reader
      // of the transcript should see the same words.
      return ok({ facts: res.data.map(toFactOutput).map((f) => ({ ...f, category: FACT_CATEGORY_LABELS[f.category as keyof typeof FACT_CATEGORY_LABELS] ? f.category : 'other' })) });
    },
  }),

  defineTool({
    name: 'memory.forget',
    aliases: ['forget_fact', 'delete_family_fact'],
    description: 'Forget a remembered fact, or dismiss something Bubaly suggested remembering.',
    domain: 'tasks',
    capability: 'delete',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      id: z.string().describe('The fact or suggestion id from memory.recall'),
      kind: z.enum(['fact', 'suggestion']).nullish().describe('Defaults to fact'),
    }),
    output: z.object({ kind: z.enum(['fact', 'suggestion']), label: z.string() }),
    summarize: (_input, output) => (output.kind === 'fact' ? `Forgot ${output.label}` : `Dismissed the suggestion about ${output.label}`),
    consequences: (input) => (input?.kind === 'suggestion'
      ? ['Dismisses the suggestion; it will not be proposed again.']
      : ['Deletes the remembered fact; future plans will not use it.']),
    execute: async (scope, input) => {
      const res = await forgetFact(scope, input.id, { kind: input.kind ?? 'fact' });
      if (!res.ok) return res;
      return ok({ kind: res.data.kind, label: res.data.label });
    },
  }),
];
