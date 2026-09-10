import 'server-only';
import { executeTool } from '@/lib/ai/tools/execute';
import { getTranslations } from '@/lib/i18n/server';
import { purchaseApprovalPath } from '@/lib/purchases/private-result';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import type { PlanOutcome, PlanRequestInput } from './index';

type PurchaseRequest = Pick<PlanRequestInput, 'requestId' | 'requestText' | 'entities'>;

/** Only one explicit dollar amount is usable; model numbers and product sizes are not prices. */
export function purchaseInputFromRequest(input: PurchaseRequest) {
  const amounts = [...input.requestText.matchAll(/(?<![-\w])(?:US\$|\$|USD\s*)\s*(-?\d[\d,]*(?:\.\d+)?)(?![\w,]|\.\d)|(?<![\w.,])(-?\d[\d,]*(?:\.\d+)?)\s*(?:US dollars?|USD|dollars?)\b/gi)];
  const rawAmount = amounts.length === 1 ? amounts[0][1] ?? amounts[0][2] : null;
  const validAmount = rawAmount !== null && /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(rawAmount);
  const amount = validAmount ? Number(rawAmount!.replaceAll(',', '')) : null;
  const categories = [...input.requestText.matchAll(/\bbudget category\s*:\s*(?:"([^"\n]{1,100})"|'([^'\n]{1,100})'|([^.;?!\n]{1,100}))|\bfrom (?:the )?["']([^"'\n]{1,100})["'] budget\b/gi)];
  const category = categories.length === 1 ? categories[0].slice(1).find(Boolean)?.trim() : null;
  let text = input.entities?.item?.trim() || input.requestText.trim();
  // The advisor uses the item's head noun. Trailing prices and budget labels
  // are separate fields, not part of that noun (a "20V drill" keeps its size).
  for (const match of categories) text = text.replace(match[0], '');
  if (validAmount) {
    const literal = amounts[0][0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?:\\s+(?:for|at|costing|priced(?: at)?)\\s*)?${literal}`, 'i'), '');
  }
  text = text.replace(/^[\s,;:?!]+|[\s,;:?!]+$/g, '').trim();
  return {
    text: (text || input.requestText.trim()).slice(0, 500),
    priceDollars: amount !== null && Number.isFinite(amount) ? amount : null,
    budgetCategory: category || null,
  };
}

/** Purchase advice is a guarded read, so a model cannot substitute an unevidenced answer. */
export async function answerPurchaseRequest(scope: ServiceScope, input: PurchaseRequest): Promise<ServiceResult<Extract<PlanOutcome, { kind: 'answer' }>>> {
  const result = await executeTool(
    { ...scope, actorKind: 'ai', requestId: input.requestId },
    'finances.advisePurchase',
    purchaseInputFromRequest(input),
    { requestId: input.requestId },
  );
  if (result.status === 'denied') return fail(result.reason, { code: SERVICE_CODES.denied });
  if (result.status === 'error') return fail(result.error, { code: SERVICE_CODES.db, retryable: result.retryable });
  if (result.status === 'pending_approval') {
    const t = await getTranslations();
    // An approval that did not persist cannot be described as waiting for review.
    if (!result.approvalId) return fail(t('beforeYouBuy.couldNotCheckThisPurchase'), { code: SERVICE_CODES.db, retryable: true });
    const waiting = t('approval.waitingForAParentOrAdult');
    const href = purchaseApprovalPath(result.approvalId);
    return ok({
      kind: 'answer', text: waiting, href,
      card: { kind: 'summary', title: waiting, facts: [], items: [], href },
    });
  }
  const answer = (result.data as { answer?: unknown } | null)?.answer;
  if (typeof answer !== 'string' || !answer.trim()) {
    const t = await getTranslations();
    return fail(t('beforeYouBuy.couldNotCheckThisPurchase'), { code: SERVICE_CODES.db, retryable: true });
  }
  // The full localized report stays in the requester's answer/conversation;
  // read results are not expanded into generic run timeline payloads.
  return ok({ kind: 'answer', text: answer });
}
