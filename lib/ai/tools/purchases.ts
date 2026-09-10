// The Ask purchase workflow reads the same evidence as the wishlist panel.
// Its finance trust gate and the service's role checks both remain in force.
import 'server-only';
import { z } from 'zod';
import { advisePurchase } from '@/lib/services/purchases';
import { describeAdvice, type PurchaseVerdict } from '@/lib/purchases/advisor';
import { purchaseAnswer } from '@/lib/purchases/answer';
import { fenceUntrustedBlock, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { getTranslations } from '@/lib/i18n/server';
import { ok } from '@/lib/services/types';
import { defineTool, type ToolDefinition } from './types';

export const purchaseTools: ToolDefinition[] = [
  defineTool({
    name: 'finances.advisePurchase',
    aliases: ['advise_purchase', 'before_you_buy'],
    description: 'Check a proposed purchase against owned inventory, home equipment, closet, saved preferences, wishlists and the category budget. Read-only; never buys, claims a gift or records a transaction. Use before answering whether the family should buy something.',
    domain: 'finances', capability: 'view', risk: 'low', readOnly: true,
    input: z.object({
      text: z.string().min(1).max(500).describe('The item being considered, in the person\'s words'),
      priceDollars: z.number().finite().nonnegative().nullish().describe('Only a price explicitly provided by the person'),
      budgetCategory: z.string().max(100).nullish().describe('A named budget category, if known'),
      excludeWishId: z.string().nullish().describe('The wishlist record the question came from, if known'),
    }),
    output: z.object({
      verdict: z.enum(['clear', 'tight', 'conflict']), reason: z.string(),
      affordability: z.enum(['clear', 'tight', 'conflict', 'unknown', 'restricted']),
      budgetRestricted: z.boolean(), memoryRestricted: z.boolean(), report: z.string(), summary: z.string(), answer: z.string(),
      evidence: z.array(z.object({ source: z.string(), id: z.string(), name: z.string() })),
    }),
    // Approval receipts are family-visible; private evidence belongs only in
    // the requester's answer, never this summary.
    summarize: (_input, output) => output.summary,
    execute: async (scope, input) => {
      const t = await getTranslations();
      const result = await advisePurchase(scope, input);
      if (!result.ok) return { ...result, error: t('beforeYouBuy.couldNotCheckThisPurchase') };
      const { advice, budgetRestricted, memoryRestricted } = result.data;
      const affordability: PurchaseVerdict | 'restricted' | 'unknown' = budgetRestricted ? 'restricted'
        : !advice.budget || advice.budget.unbudgeted ? 'unknown' : advice.budget.verdict;
      // Missing prices and withheld budgets cannot become permission to spend.
      const report = describeAdvice(input.text, budgetRestricted ? { ...advice, budget: null } : advice)
        + (affordability === 'restricted' ? '\nAffordability was not assessed: this viewer cannot read household finances.'
          : affordability === 'unknown' ? '\nAffordability was not assessed: a price and a matching category budget are required.' : '')
        + (memoryRestricted ? '\nRemembered preferences were not assessed: the family has memory switched off.' : '')
        + '\nRelated equipment is evidence to check compatibility, not confirmation that the candidate fits. This check does not purchase anything.';
      return ok({
        verdict: advice.verdict, reason: advice.reason, affordability, budgetRestricted, memoryRestricted,
        report: fenceUntrustedBlock('purchase_evidence', report),
        answer: purchaseAnswer(input.text, advice, budgetRestricted, memoryRestricted, t),
        evidence: [
          ...advice.duplicates.map((row) => ({ source: row.source, id: row.id, name: row.name })),
          ...advice.compatibility.map((row) => ({ source: row.source, id: row.id, name: row.name })),
          ...advice.preferences.map((row) => ({ source: 'family_facts', id: row.id, name: row.label })),
          ...advice.alreadyOnList.map((row) => ({ source: 'wishlist_items', id: row.id, name: row.title })),
        ].map((row) => ({ ...row, name: sanitizeUntrusted(row.name, 160) })),
        summary: t('purchaseAdvice.checked'),
      });
    },
  }),
];
