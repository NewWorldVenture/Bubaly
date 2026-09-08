'use server';

// Publication switch for the public /resources/benchmarks page. The admin
// layout gates the RENDER of /admin/benchmarks; this action is an RPC endpoint
// of its own and re-verifies super-admin through requireMarketingAdmin, which
// throws for anyone else (A-17). The flag lives in marketing_settings because
// publishing a research page is a marketing decision, and that table already
// carries the admin-only RLS and the audit trail.

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { BENCHMARKS_PUBLICATION_KEY } from '@/lib/network/benchmarks';

export async function setBenchmarksPublicationAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const enabled = String(formData.get('published') ?? '') === 'true';
  const { data, error } = await supabase.from('marketing_settings')
    .upsert({ key: BENCHMARKS_PUBLICATION_KEY, value: { enabled }, updated_by: actorId })
    .select('key').maybeSingle();
  if (error || !data) marketingActionFailure('update the benchmarks publication flag', error ?? new Error('Benchmarks publication flag was not saved'));
  await logMarketingAudit(supabase, {
    actorId, actorEmail, action: enabled ? 'publish' : 'unpublish',
    resource: 'household_benchmarks', resourceId: BENCHMARKS_PUBLICATION_KEY, metadata: { enabled },
  });
  revalidatePath('/admin/benchmarks');
  revalidatePath('/resources/benchmarks');
  revalidatePath('/sitemap.xml');
}
