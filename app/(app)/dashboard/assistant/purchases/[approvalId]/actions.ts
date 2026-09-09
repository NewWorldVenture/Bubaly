'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { purchaseApprovalPath } from '@/lib/purchases/private-result';
import { retryPrivatePurchaseAnswer } from '@/lib/services/purchases/private-result';

export async function retryPurchaseAnswer(approvalId: string): Promise<void> {
  const ctx = await requireUserContext();
  const scope = scopeFromUserContext(ctx, await createServer());
  const result = await retryPrivatePurchaseAnswer(scope, approvalId);
  const path = purchaseApprovalPath(approvalId);
  revalidatePath(path);
  redirect(result.ok ? path : `${path}?retry=failed`);
}
