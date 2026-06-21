// lib/social/publish.ts
// Server-side publish pipeline. Creates a publish job, runs each target through
// its connector, records a real social_publish_results row per target, and rolls
// the per-target outcomes up into the post status via derivePostStatus. Nothing
// is marked 'published' unless a connector confirmed it.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getConnector } from './connectors';
import { derivePostStatus, type TargetStatus } from './content';
import type { SocialPlatform } from './capabilities';

type Client = SupabaseClient<Database>;

export type PublishOutcome = {
  postId: string;
  jobId: string;
  status: string;
  targets: Array<{
    targetId: string;
    platform: SocialPlatform;
    status: TargetStatus;
    permalinkUrl: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
};

/** Create the per-platform target rows for a post from selected accounts. */
export async function createTargets(
  supabase: Client,
  familyId: string,
  postId: string,
  accountIds: string[],
  scheduledFor: string | null,
): Promise<void> {
  if (accountIds.length === 0) return;
  const { data: accounts } = await supabase
    .from('social_accounts')
    .select('id, platform')
    .eq('family_id', familyId)
    .in('id', accountIds);

  const rows = (accounts ?? []).map((a) => ({
    post_id: postId,
    family_id: familyId,
    account_id: a.id,
    platform: a.platform,
    status: (scheduledFor ? 'pending' : 'pending') as TargetStatus,
    scheduled_for: scheduledFor,
  }));
  if (rows.length) {
    await supabase.from('social_post_targets').insert(rows);
  }
}

/**
 * Execute publishing for a post NOW: run each pending target through its
 * connector, persist results, and update statuses. Returns the per-target
 * outcomes so the UI can show honest success/failure per platform.
 */
export async function runPublishNow(
  supabase: Client,
  familyId: string,
  postId: string,
  userId: string | null,
): Promise<PublishOutcome> {
  // Create the job row (RLS requires publish/schedule permission).
  const { data: job, error: jobErr } = await supabase
    .from('social_publish_jobs')
    .insert({
      post_id: postId,
      family_id: familyId,
      status: 'running',
      scheduled_for: new Date().toISOString(),
      attempts: 1,
      created_by: userId,
    })
    .select('id')
    .single();
  if (jobErr || !job) {
    throw new Error(jobErr?.message ?? 'Could not create publish job');
  }

  await supabase.from('social_posts').update({ status: 'publishing', updated_by: userId }).eq('id', postId).eq('family_id', familyId);

  const { data: targets } = await supabase
    .from('social_post_targets')
    .select('id, platform, account_id')
    .eq('post_id', postId)
    .eq('family_id', familyId)
    .in('status', ['pending', 'failed']);

  const { data: variants } = await supabase
    .from('social_post_variants')
    .select('platform, body')
    .eq('post_id', postId)
    .eq('family_id', familyId);

  const { data: post } = await supabase
    .from('social_posts')
    .select('body, link')
    .eq('id', postId)
    .eq('family_id', familyId)
    .single();

  const variantByPlatform = new Map((variants ?? []).map((v) => [v.platform, v.body]));
  const outcomes: PublishOutcome['targets'] = [];
  const finalStatuses: TargetStatus[] = [];

  for (const target of targets ?? []) {
    const platform = target.platform as SocialPlatform;
    let providerAccountId: string | null = null;
    if (target.account_id) {
      const { data: acct } = await supabase
        .from('social_accounts')
        .select('provider_account_id')
        .eq('id', target.account_id)
        .maybeSingle();
      providerAccountId = acct?.provider_account_id ?? null;
    }

    await supabase.from('social_post_targets').update({ status: 'publishing' }).eq('id', target.id);

    const connector = getConnector(platform);
    const result = await connector.publish({
      platform,
      providerAccountId,
      body: variantByPlatform.get(platform) ?? post?.body ?? '',
      link: post?.link ?? null,
      mediaUrls: [],
    });

    finalStatuses.push(result.status);

    await supabase
      .from('social_post_targets')
      .update({
        status: result.status,
        provider_object_id: result.providerObjectId ?? null,
        permalink_url: result.permalinkUrl ?? null,
        error: result.errorMessage ?? null,
        published_at: result.ok ? new Date().toISOString() : null,
      })
      .eq('id', target.id);

    await supabase.from('social_publish_results').insert({
      job_id: job.id,
      target_id: target.id,
      post_id: postId,
      family_id: familyId,
      account_id: target.account_id,
      platform,
      status: result.status,
      provider_object_id: result.providerObjectId ?? null,
      permalink_url: result.permalinkUrl ?? null,
      error_code: result.errorCode ?? null,
      error_message: result.errorMessage ?? null,
      raw_response: (result.raw ?? {}) as Database['public']['Tables']['social_publish_results']['Insert']['raw_response'],
      created_by: userId,
    });

    outcomes.push({
      targetId: target.id,
      platform,
      status: result.status,
      permalinkUrl: result.permalinkUrl ?? null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
    });
  }

  const postStatus = derivePostStatus(finalStatuses);
  await supabase
    .from('social_posts')
    .update({
      status: postStatus,
      published_at: postStatus === 'published' || postStatus === 'partially_published' ? new Date().toISOString() : null,
      updated_by: userId,
    })
    .eq('id', postId)
    .eq('family_id', familyId);

  const jobStatus = finalStatuses.some((s) => s === 'published') ? 'succeeded' : 'failed';
  await supabase.from('social_publish_jobs').update({ status: jobStatus }).eq('id', job.id);

  await supabase.from('social_usage_events').insert({
    family_id: familyId,
    user_id: userId,
    kind: 'publish',
    quantity: outcomes.length,
    unit: 'targets',
  });

  return { postId, jobId: job.id, status: postStatus, targets: outcomes };
}
