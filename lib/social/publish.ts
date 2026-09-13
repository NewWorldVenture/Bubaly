// lib/social/publish.ts
// Server-side publish pipeline. Creates a publish job, runs each target through
// its connector, records a real social_publish_results row per target, and rolls
// the per-target outcomes up into the post status via derivePostStatus. Nothing
// is marked 'published' unless a connector confirmed it.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getConnector, type ConnectorPublishInput, type ConnectorPublishOutput } from './connectors';
import { needsPublishApproval, scheduleFailure } from './scheduled-authority';
import { derivePostStatus, type TargetStatus } from './content';
import type { SocialPlatform } from './capabilities';

type Client = SupabaseClient<Database>;

const PUBLISH_PERSISTENCE_FAILURE =
  'Social publishing could not be saved completely. Review the post status before retrying.';

function throwPersistenceFailure(stage: string, error: unknown): never {
  console.error(`[social-publish] ${stage}`, error);
  throw new Error(PUBLISH_PERSISTENCE_FAILURE);
}

async function markJobFailed(
  supabase: Client,
  familyId: string,
  jobId: string,
  userId: string | null,
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from('social_publish_jobs')
    .update({ status: 'failed', last_error: message, updated_by: userId })
    .eq('id', jobId)
    .eq('family_id', familyId);
  if (error) console.error('[social-publish] failed-job update failed', error);
}

async function abortJob(
  supabase: Client,
  familyId: string,
  jobId: string,
  userId: string | null,
  stage: string,
  error: unknown,
  message = PUBLISH_PERSISTENCE_FAILURE,
): Promise<never> {
  await markJobFailed(supabase, familyId, jobId, userId, message);
  console.error(`[social-publish] ${stage}`, error);
  throw new Error(message);
}

export type PublishOutcome = {
  postId: string;
  jobId: string | null;
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
): Promise<number> {
  const requestedIds = Array.from(new Set(accountIds));
  if (requestedIds.length === 0) return 0;
  const { data: accounts, error: accountError } = await supabase
    .from('social_accounts')
    .select('id, platform')
    .eq('family_id', familyId)
    .is('deleted_at', null)
    .in('id', requestedIds);
  if (accountError) throwPersistenceFailure('target account lookup failed', accountError);
  if ((accounts ?? []).length !== requestedIds.length) {
    throw new Error('One or more selected social accounts are unavailable. Refresh and try again.');
  }

  const rows = (accounts ?? []).map((a) => ({
    post_id: postId,
    family_id: familyId,
    account_id: a.id,
    platform: a.platform,
    status: (scheduledFor ? 'pending' : 'pending') as TargetStatus,
    scheduled_for: scheduledFor,
  }));
  if (rows.length) {
    const { error } = await supabase.from('social_post_targets').insert(rows);
    if (error) throwPersistenceFailure('target creation failed', error);
  }
  return rows.length;
}

type Target = Database['public']['Tables']['social_post_targets']['Row'];
type Json = Database['public']['Tables']['social_posts']['Row']['metadata'];

function metadataObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Read to an empty page, including when the API applies a smaller row cap. */
async function readTargets(supabase: Client, familyId: string, postId: string): Promise<Target[]> {
  const all: Target[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 2001; page += 1) {
    let query = supabase.from('social_post_targets').select('*')
      .eq('post_id', postId).eq('family_id', familyId)
      .order('id', { ascending: true }).limit(200);
    if (cursor) query = query.gt('id', cursor);
    const { data: targets, error: targetsError } = await query;
    if (targetsError || !targets) throwPersistenceFailure('publish-target lookup failed', targetsError);
    if (!targets.length) return all;
    if (all.length + targets.length > 2000) {
      throwPersistenceFailure('publish-target limit exceeded', new Error('Too many targets'));
    }
    const next = targets[targets.length - 1].id;
    if (cursor && next <= cursor) throwPersistenceFailure('publish-target cursor did not advance', null);
    all.push(...targets);
    cursor = next;
  }
  throwPersistenceFailure('publish-target page limit exceeded', null);
}

function uncertainResult(): ConnectorPublishOutput {
  return {
    ok: false, status: 'publishing', errorCode: 'confirmation_unknown',
    errorMessage: 'The provider could not confirm this post. Review the result before posting again.',
  };
}

function confirmedResult(result: ConnectorPublishOutput): ConnectorPublishOutput {
  if (result.ok === true && result.status === 'published'
    && typeof result.providerObjectId === 'string' && result.providerObjectId.trim()) return result;
  if (result.ok === false && !result.providerObjectId
    && (result.status === 'failed' || result.status === 'skipped')) return result;
  if (result.ok === false && result.status === 'publishing'
    && result.errorCode === 'confirmation_unknown') return result;
  // An exception or an inconsistent receipt may follow provider acceptance.
  // It must never become a failed target that an ordinary retry will resend.
  return uncertainResult();
}

function savedOutcomes(targets: Target[]): PublishOutcome['targets'] {
  return targets.map((target) => ({
    targetId: target.id, platform: target.platform, status: target.status,
    permalinkUrl: target.permalink_url, errorCode: null, errorMessage: target.error,
  }));
}

/**
 * Publish under an exclusive post claim and a conditional claim for each target.
 * A crashed or unconfirmed send stays publishing for review; there is no lease
 * expiry that could send the same external post again.
 */
export async function runPublishNow(
  supabase: Client,
  familyId: string,
  postId: string,
  userId: string | null,
  options: { publishTarget?: (input: ConnectorPublishInput, targetId: string) => Promise<ConnectorPublishOutput> } = {},
): Promise<PublishOutcome> {
  const { data: post, error: postError } = await supabase
    .from('social_posts')
    .select('*').eq('id', postId).eq('family_id', familyId)
    .is('deleted_at', null).single();
  if (postError || !post) throwPersistenceFailure('post lookup failed', postError);
  const targets = await readTargets(supabase, familyId, postId);
  const eligible = targets.filter((target) => target.status === 'pending' || target.status === 'failed');
  // No state writes on an already completed/in-flight post or an empty retry.
  // In particular, this cannot replace a prior published timestamp with null.
  if (post.status === 'publishing' || post.status === 'published' || !eligible.length
    || targets.some((target) => target.status === 'publishing')) {
    const observedStatus = post.status === 'publishing' ? 'publishing'
      : targets.length ? derivePostStatus(targets.map((target) => target.status)) : post.status;
    return { postId, jobId: null, status: observedStatus, targets: savedOutcomes(targets) };
  }
  if (!['draft', 'scheduled', 'failed', 'partially_published'].includes(post.status)) {
    throw new Error('This post is not available for publishing.');
  }
  if (await needsPublishApproval(supabase, familyId, post.approval_status)) scheduleFailure('approvalRequired');

  const variantByPlatform = new Map<SocialPlatform, string>();
  let variantCursor: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page > 100) throwPersistenceFailure('post-variant limit exceeded', null);
    let query = supabase.from('social_post_variants').select('id, platform, body')
      .eq('post_id', postId).eq('family_id', familyId)
      .order('id', { ascending: true }).limit(100);
    if (variantCursor) query = query.gt('id', variantCursor);
    const { data: variants, error: variantsError } = await query;
    if (variantsError || !variants) throwPersistenceFailure('post-variant lookup failed', variantsError);
    if (!variants.length) break;
    for (const variant of variants) {
      if (variantByPlatform.has(variant.platform)) throwPersistenceFailure('ambiguous post variants', null);
      variantByPlatform.set(variant.platform, variant.body);
    }
    const next = variants[variants.length - 1].id;
    if (variantCursor && next <= variantCursor) throwPersistenceFailure('post-variant cursor did not advance', null);
    variantCursor = next;
  }
  // Resolve required accounts before taking a claim or contacting any provider.
  const providerAccounts = new Map<string, string | null>();
  const accountCounts = new Map<string, number>();
  for (const target of targets) {
    if (target.account_id) accountCounts.set(target.account_id, (accountCounts.get(target.account_id) ?? 0) + 1);
  }
  for (const target of eligible) {
    if (!target.account_id) throwPersistenceFailure('missing target account', null);
    if (target.provider_object_id || accountCounts.get(target.account_id) !== 1) {
      throwPersistenceFailure('duplicate or previously confirmed target requires review', null);
    }
    const { data: account, error: accountError } = await supabase
      .from('social_accounts').select('provider_account_id, platform')
      .eq('id', target.account_id).eq('family_id', familyId)
      .is('deleted_at', null).maybeSingle();
    if (accountError || !account || account.platform !== target.platform) {
      throwPersistenceFailure('publish account lookup failed', accountError);
    }
    providerAccounts.set(target.id, account.provider_account_id);
  }

  const { data: job, error: jobErr } = await supabase
    .from('social_publish_jobs')
    .insert({
      post_id: postId, family_id: familyId, status: 'running',
      scheduled_for: new Date().toISOString(), attempts: 1, created_by: userId,
    }).select('id').single();
  if (jobErr || !job) throwPersistenceFailure('publish-job creation failed', jobErr);
  const claim = { publish_job_id: job.id };
  const { data: publishingPost, error: publishingPostError } = await supabase
    .from('social_posts')
    .update({ status: 'publishing', metadata: { ...metadataObject(post.metadata), ...claim }, updated_by: userId })
    .eq('id', postId).eq('family_id', familyId).is('deleted_at', null)
    .eq('status', post.status).eq('updated_at', post.updated_at)
    .select('id').maybeSingle();
  if (publishingPostError || !publishingPost) {
    return abortJob(supabase, familyId, job.id, userId, 'post publishing claim unavailable', publishingPostError);
  }

  const outcomes: PublishOutcome['targets'] = [];
  try {
    for (const target of eligible) {
      const { data: publishingTarget, error: publishingTargetError } = await supabase
        .from('social_post_targets')
        .update({ status: 'publishing', metadata: { ...metadataObject(target.metadata), ...claim }, updated_by: userId })
        .eq('id', target.id).eq('post_id', postId).eq('family_id', familyId)
        .eq('status', target.status).eq('updated_at', target.updated_at)
        .select('id').maybeSingle();
      if (publishingTargetError || !publishingTarget) {
        throwPersistenceFailure('target publishing claim unavailable', publishingTargetError);
      }

      let result: ConnectorPublishOutput;
      try {
        const input: ConnectorPublishInput = {
          platform: target.platform, familyId, accountId: target.account_id ?? undefined,
          userId: userId ?? undefined, kind: post.kind,
          providerAccountId: providerAccounts.get(target.id) ?? null,
          body: variantByPlatform.get(target.platform) ?? post.body,
          link: post.link ?? null, mediaUrls: [],
        };
        result = confirmedResult(await (options.publishTarget ? options.publishTarget(input, target.id) : getConnector(target.platform).publish(input)));
      } catch {
        result = uncertainResult();
      }

      // A confirmed provider receipt is durable before the target is completed.
      const { error: resultError } = await supabase.from('social_publish_results').insert({
        job_id: job.id, target_id: target.id, post_id: postId, family_id: familyId,
        account_id: target.account_id, platform: target.platform, status: result.status,
        provider_object_id: result.providerObjectId ?? null,
        permalink_url: result.permalinkUrl ?? null, error_code: result.errorCode ?? null,
        error_message: result.errorMessage ?? null, raw_response: (result.raw ?? {}) as Json,
        created_by: userId,
      });
      if (resultError) throwPersistenceFailure('publish-result persistence failed', resultError);
      const { data: savedTarget, error: targetError } = await supabase
        .from('social_post_targets')
        .update({
          status: result.status, provider_object_id: result.providerObjectId ?? null,
          permalink_url: result.permalinkUrl ?? null, error: result.errorMessage ?? null,
          published_at: result.ok ? new Date().toISOString() : null, updated_by: userId,
        }).eq('id', target.id).eq('post_id', postId).eq('family_id', familyId)
        .eq('status', 'publishing').contains('metadata', claim)
        .select('id').single();
      if (targetError || !savedTarget) throwPersistenceFailure('target outcome persistence failed', targetError);
      outcomes.push({
        targetId: target.id, platform: target.platform, status: result.status,
        permalinkUrl: result.permalinkUrl ?? null,
        errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null,
      });
    }

    // Include successes from earlier attempts. This attempt alone is not the
    // state of a post that already reached one or more platforms.
    const persisted = await readTargets(supabase, familyId, postId);
    const postStatus = derivePostStatus(persisted.map((target) => target.status));
    const firstPublishedAt = persisted.filter((target) => target.status === 'published' && target.published_at)
      .map((target) => target.published_at!).sort()[0] ?? null;
    const { data: savedPost, error: finalPostError } = await supabase
      .from('social_posts')
      .update({
        status: postStatus, published_at: post.published_at ?? firstPublishedAt, updated_by: userId,
      }).eq('id', postId).eq('family_id', familyId).is('deleted_at', null)
      .eq('status', 'publishing').contains('metadata', claim)
      .select('id').single();
    if (finalPostError || !savedPost) throwPersistenceFailure('final post status persistence failed', finalPostError);

    const unknown = outcomes.some((outcome) => outcome.status === 'publishing');
    const { data: savedJob, error: finalJobError } = await supabase
      .from('social_publish_jobs')
      .update({
        status: unknown ? 'running' : outcomes.some((outcome) => outcome.status === 'published') ? 'succeeded' : 'failed',
        last_error: unknown ? uncertainResult().errorMessage : null, updated_by: userId,
      }).eq('id', job.id).eq('family_id', familyId).select('id').single();
    if (finalJobError || !savedJob) throwPersistenceFailure('final job status persistence failed', finalJobError);
    const { error: usageError } = await supabase.from('social_usage_events').insert({
      family_id: familyId, user_id: userId, kind: 'publish', quantity: outcomes.length, unit: 'targets',
    });
    if (usageError) console.error('[social-publish] usage event persistence failed', usageError);
    return { postId, jobId: job.id, status: postStatus, targets: outcomes };
  } catch (error) {
    // Keep post/target claims: an interrupted operation may have reached the
    // provider. Only explicit confirmed outcomes can release that target.
    return abortJob(supabase, familyId, job.id, userId, 'publish interrupted', error);
  }
}
