import 'server-only';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { getConnector, type ConnectorPublishInput, type ConnectorPublishOutput } from './connectors';
import { derivePostStatus } from './content';
import { runPublishNow, type PublishOutcome } from './publish';
import { assertXCredentials } from './account-tokens';
import {
  ScheduledPublishError, SCHEDULE_TOOL, scheduleFailure, scheduleIdentity, scheduleSignal,
  readSchedule, changeSchedule, checkScheduleActor, requestScheduleActor, readScheduleSnapshot,
  verifyScheduleSnapshot, priorProviderResult,
  type ScheduleDb, type ScheduleExpected, type ScheduleActor, type ScheduleInputs, type ScheduleReceipt,
} from './scheduled-authority';
export { ScheduledPublishError } from './scheduled-authority';

export async function createScheduledPublishReceipt(input: {
  familyId: string; postId: string; scheduleId: string; scheduledFor: string; timezone: string; expected: ScheduleExpected;
}): Promise<{ receiptId: string }> {
  try {
    if (!['text', 'link'].includes(input.expected.kind) || input.expected.accountIds.length < 1 || input.expected.accountIds.length > 10
      || new Set(input.expected.accountIds).size !== input.expected.accountIds.length) return scheduleFailure('unsupported');
    const instant = new Date(input.scheduledFor);
    if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== input.scheduledFor || instant.getTime() <= Date.now()) return scheduleFailure('invalid');
    try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format(instant); } catch { return scheduleFailure('invalid'); }
    const db = createServiceClient(), { actor } = await requestScheduleActor(input.familyId);
    await checkScheduleActor(db, input.familyId, actor, 'schedule_posts');
    const current = await readScheduleSnapshot(db, input);
    if (current.post.status !== 'scheduled' || current.snapshot.kind !== input.expected.kind || current.snapshot.body !== input.expected.body
      || current.snapshot.link !== input.expected.link || current.snapshot.variants.some(variant => variant.body !== input.expected.body)
      || JSON.stringify(current.snapshot.targets.map(target => target.accountId).sort()) !== JSON.stringify([...input.expected.accountIds].sort())) return scheduleFailure('changed');
    await assertXCredentials({ familyId: input.familyId, userId: actor.userId }, current.snapshot.targets).catch(() => scheduleFailure('reconnectRequired'));
    const identity = scheduleIdentity(input.familyId, input.postId);
    const inputs: ScheduleInputs = { version: 1, familyId: input.familyId, postId: input.postId, scheduleId: input.scheduleId,
      scheduledFor: input.scheduledFor, timezone: input.timezone, actor, authorizedAt: new Date().toISOString(),
      approvalRequired: current.approvalRequired, snapshot: current.snapshot };
    const inserted = await db.from('ai_tool_calls').insert({ id: identity.id, family_id: input.familyId, tool_name: SCHEDULE_TOOL,
      idempotency_key: identity.key, actor_kind: 'system', requested_by: null, requested_by_member_id: null,
      run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
      resource_table: 'social_posts', resource_id: input.postId, inputs,
      outputs: { version: 1, revision: randomUUID(), phase: 'unarmed', actor: null, retryAt: null, reconcile: false, drain: false, errorKey: null,
        targets: current.snapshot.targets.map(target => ({ targetId: target.id, phase: 'pending', providerObjectId: null,
          permalinkUrl: null, confirmedAt: null, errorCode: null, errorMessage: null })) },
      state: 'reserved', attempt: 0,
    }).select('id').abortSignal(scheduleSignal());
    if (inserted.error && inserted.error.code !== '23505') return scheduleFailure();
    const receipt = await readSchedule(db, identity.id);
    if (!receipt || receipt.outputs.phase !== 'unarmed' || receipt.inputs.actor.userId !== actor.userId || receipt.inputs.actor.memberId !== actor.memberId
      || receipt.inputs.scheduleId !== input.scheduleId || receipt.inputs.scheduledFor !== input.scheduledFor || receipt.inputs.timezone !== input.timezone
      || receipt.inputs.approvalRequired !== current.approvalRequired || JSON.stringify(receipt.inputs.snapshot) !== JSON.stringify(current.snapshot)) return scheduleFailure('changed');
    return { receiptId: receipt.id };
  } catch (error) { if (error instanceof ScheduledPublishError) throw error; return scheduleFailure(); }
}

export async function armScheduledPublishReceipt(receiptId: string): Promise<{ phase: 'queued' | 'approval_required' }> {
  const db = createServiceClient(), receipt = await readSchedule(db, receiptId);
  if (!receipt) return scheduleFailure();
  const { actor } = await requestScheduleActor(receipt.family_id);
  if (JSON.stringify(actor) !== JSON.stringify(receipt.inputs.actor)) return scheduleFailure('permissionDenied');
  await checkScheduleActor(db, receipt.family_id, actor, 'schedule_posts');
  const current = await verifyScheduleSnapshot(db, receipt);
  if (receipt.outputs.phase === 'approval_required') return { phase: 'approval_required' };
  if (receipt.outputs.phase === 'queued' && !current.approvalRequired) return { phase: 'queued' };
  if (!['unarmed', 'queued'].includes(receipt.outputs.phase) || current.post.status !== 'scheduled' || Date.parse(receipt.inputs.scheduledFor) <= Date.now()) return scheduleFailure('changed');
  await assertXCredentials({ familyId: receipt.family_id, userId: actor.userId }, current.snapshot.targets).catch(() => scheduleFailure('reconnectRequired'));
  const phase = current.approvalRequired ? 'approval_required' : 'queued';
  const t = await getTranslations();
  const saved = await changeSchedule(db, receipt, { ...receipt.outputs, phase, reconcile: true },
    { error: phase === 'approval_required' ? t('socialSchedule.approvalRequired') : null });
  if (!saved) return scheduleFailure('saveUnconfirmed');
  await reconcileScheduledPost(db, saved).catch(() => undefined);
  return { phase };
}

function receiptOutcome(receipt: ScheduleReceipt): PublishOutcome {
  const targets: PublishOutcome['targets'] = receipt.outputs.targets.map((target, i) => ({
    targetId: target.targetId, platform: receipt.inputs.snapshot.targets[i].platform,
    status: target.phase === 'dispatching' || target.phase === 'unknown' ? 'publishing' : target.phase,
    permalinkUrl: target.permalinkUrl, errorCode: target.errorCode, errorMessage: target.errorMessage,
  }));
  const status = receipt.outputs.phase === 'dispatching' || receipt.outputs.phase === 'unknown' ? 'publishing'
    : receipt.outputs.phase === 'failed' && receipt.outputs.targets.every(target => target.phase === 'pending') ? 'failed'
    : ['unarmed', 'queued', 'approval_required'].includes(receipt.outputs.phase) && receipt.attempt === 0 ? 'scheduled'
    : derivePostStatus(targets.map(target => target.status));
  return { postId: receipt.inputs.postId, jobId: null, status, targets };
}

/** Presentation repair uses private provider proof, never another provider call. */
export async function reconcileScheduledPost(db: ScheduleDb, receipt: ScheduleReceipt, parentSignal?: AbortSignal): Promise<void> {
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const currentReceipt = await readSchedule(db, receipt.id, signal);
  if (!currentReceipt || currentReceipt.outputs.revision !== receipt.outputs.revision) return;
  const outcome = receiptOutcome(receipt);
  const status = receipt.outputs.phase === 'approval_required' ? 'approval_required' : outcome.status;
  const error = receipt.outputs.errorKey;
  const metadata = (value: unknown) => ({ ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    schedule_phase: receipt.outputs.phase, schedule_error: error });
  const [postRow, scheduleRow, calendarRows] = await Promise.all([
    db.from('social_posts').select('id,status,published_at,updated_at,metadata').eq('id', receipt.inputs.postId).eq('family_id', receipt.family_id).is('deleted_at', null).abortSignal(scheduleSignal(signal)).single(),
    db.from('social_schedules').select('id,updated_at,metadata').eq('id', receipt.inputs.scheduleId).eq('family_id', receipt.family_id).eq('post_id', receipt.inputs.postId).abortSignal(scheduleSignal(signal)).single(),
    db.from('social_calendar_items').select('id,updated_at,metadata').eq('post_id', receipt.inputs.postId).eq('family_id', receipt.family_id).in('id', receipt.inputs.snapshot.calendarIds).abortSignal(scheduleSignal(signal)),
  ]);
  if (postRow.error || !postRow.data || scheduleRow.error || !scheduleRow.data || calendarRows.error || calendarRows.data?.length !== receipt.inputs.snapshot.calendarIds.length) return scheduleFailure();
  for (const target of receipt.outputs.targets) {
    if (!['completed', 'unknown'].includes(receipt.outputs.phase)) break;
    if (!['published', 'failed', 'skipped'].includes(target.phase)) continue;
    const identity = receipt.inputs.snapshot.targets.find(item => item.id === target.targetId)!;
    const saved = await db.from('social_post_targets').update({ status: target.phase as 'published' | 'failed' | 'skipped',
      provider_object_id: target.providerObjectId, permalink_url: target.permalinkUrl, error: target.errorMessage,
      ...(target.phase === 'published' ? { published_at: target.confirmedAt } : {}),
    }).eq('id', target.targetId).eq('family_id', receipt.family_id).eq('post_id', receipt.inputs.postId)
      .eq('account_id', identity.accountId).eq('platform', identity.platform).select('id').abortSignal(scheduleSignal(signal)).single();
    if (saved.error || !saved.data) return scheduleFailure();
  }
  const [schedule, calendar] = await Promise.all([
    db.from('social_schedules').update({ status, metadata: metadata(scheduleRow.data.metadata) }).eq('id', receipt.inputs.scheduleId).eq('post_id', receipt.inputs.postId)
      .eq('family_id', receipt.family_id).eq('updated_at', scheduleRow.data.updated_at).select('id').abortSignal(scheduleSignal(signal)).single(),
    db.from('social_calendar_items').update({ status, metadata: metadata(calendarRows.data[0].metadata) }).eq('post_id', receipt.inputs.postId).eq('family_id', receipt.family_id)
      .eq('id', calendarRows.data[0].id).eq('updated_at', calendarRows.data[0].updated_at).select('id').abortSignal(scheduleSignal(signal)),
  ]);
  if (schedule.error || !schedule.data || calendar.error || calendar.data?.length !== receipt.inputs.snapshot.calendarIds.length) return scheduleFailure();
  const post = await db.from('social_posts').update({ metadata: metadata(postRow.data.metadata),
    ...(receipt.outputs.phase === 'completed' ? { status: 'published' as const,
      published_at: postRow.data.published_at ?? receipt.outputs.targets.map(target => target.confirmedAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null } : {}) })
    .eq('id', receipt.inputs.postId).eq('family_id', receipt.family_id).is('deleted_at', null)
    .eq('status', postRow.data.status).eq('updated_at', postRow.data.updated_at).select('id').abortSignal(scheduleSignal(signal)).single();
  if (post.error || !post.data) return scheduleFailure();
  if (receipt.outputs.reconcile && receipt.outputs.phase !== 'dispatching') await changeSchedule(db, receipt, { ...receipt.outputs, reconcile: false }, {}, signal);
}

function boundedClient(db: ScheduleDb, signal: AbortSignal): ScheduleDb {
  return new Proxy(db, { get(target, key) {
    if (key === 'from') return (table: string) => new Proxy(Reflect.apply(target.from, target, [table]), {
      get(builder, method) {
        const value = Reflect.get(builder, method);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, builder, args);
          return result && typeof result === 'object' && 'abortSignal' in result && typeof result.abortSignal === 'function'
            ? result.abortSignal(scheduleSignal(signal)) : result;
        };
      },
    });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function validProviderResult(result: ConnectorPublishOutput): ConnectorPublishOutput {
  if (result.ok && result.status === 'published' && typeof result.providerObjectId === 'string' && /^[1-9][0-9]{0,19}$/.test(result.providerObjectId)) return result;
  if (!result.ok && !result.providerObjectId && ['failed', 'skipped'].includes(result.status)) return result;
  return { ok: false, status: 'publishing', errorCode: 'confirmation_unknown' };
}

async function executeScheduled(db: ScheduleDb, original: ScheduleReceipt, actor: ScheduleActor, manual: boolean, signal: AbortSignal,
  now = new Date(), completionSignal = AbortSignal.timeout(100_000)): Promise<PublishOutcome> {
  if (original.outputs.phase === 'approval_required') return scheduleFailure('approvalRequired');
  if (['dispatching', 'unknown', 'completed'].includes(original.outputs.phase)) return receiptOutcome(original);
  if (original.outputs.phase === 'unarmed') return scheduleFailure('saveUnconfirmed');
  if (!manual && (original.outputs.phase !== 'queued' || Date.parse(original.inputs.scheduledFor) > now.getTime()
    || (original.outputs.retryAt && Date.parse(original.outputs.retryAt) > now.getTime()))) return receiptOutcome(original);
  if (original.attempt >= 3) return receiptOutcome(original);
  await checkScheduleActor(db, original.family_id, actor, manual ? 'publish_posts' : 'schedule_posts', signal);
  await checkScheduleActor(db, original.family_id, actor, 'publish_posts', signal);
  const current = await verifyScheduleSnapshot(db, original, signal);
  const t = await getTranslations();
  if (current.approvalRequired) {
    await changeSchedule(db, original, { ...original.outputs, phase: 'approval_required', reconcile: true }, { error: t('socialSchedule.approvalRequired') }, signal);
    return scheduleFailure('approvalRequired');
  }
  if (signal.aborted) return scheduleFailure();
  let receipt = await changeSchedule(db, original, { ...original.outputs, phase: 'dispatching', actor, retryAt: null, reconcile: true },
    { attempt: original.attempt + 1, error: t('socialSchedule.awaitingConfirmation') }, signal);
  if (!receipt) return receiptOutcome((await readSchedule(db, original.id, signal)) ?? original);
  await reconcileScheduledPost(db, receipt, signal).catch(() => undefined);
  const publishTarget = async (input: ConnectorPublishInput, targetId: string): Promise<ConnectorPublishOutput> => {
    const saved = receipt!.outputs.targets.find(target => target.targetId === targetId);
    if (!saved) return scheduleFailure('changed');
    if (['published', 'unknown', 'dispatching'].includes(saved.phase)) return priorProviderResult(saved);
    if (!manual && saved.phase === 'failed' && saved.errorCode !== 'rate_limited') return priorProviderResult(saved);
    let result: ConnectorPublishOutput;
    try {
      const fresh = await verifyScheduleSnapshot(db, receipt!, signal);
      if (fresh.approvalRequired) scheduleFailure('approvalRequired');
      await checkScheduleActor(db, receipt!.family_id, actor, 'publish_posts', signal);
      if (signal.aborted) scheduleFailure();
      const next = await changeSchedule(db, receipt!, { ...receipt!.outputs,
        targets: receipt!.outputs.targets.map(target => target.targetId === targetId ? { ...target, phase: 'dispatching' } : target) }, {}, signal);
      if (!next) return scheduleFailure('awaitingConfirmation');
      receipt = next;
      result = validProviderResult(await getConnector(input.platform).publish({ ...input, signal,
        scheduledClaim: { receiptId: receipt.id, revision: receipt.outputs.revision, targetId } }));
    } catch (error) {
      const started = receipt!.outputs.targets.find(target => target.targetId === targetId)?.phase === 'dispatching';
      result = started ? { ok: false, status: 'publishing', errorCode: 'confirmation_unknown' }
        : { ok: false, status: 'failed', errorCode: 'preflight_failed', errorMessage: t(error instanceof ScheduledPublishError ? error.key : 'socialSchedule.storageUnavailable') };
    }
    const phase = result.status === 'publishing' ? 'unknown' : result.status as 'published' | 'failed' | 'skipped';
    const errorMessage = result.ok ? null : result.status === 'publishing' ? t('socialSchedule.awaitingConfirmation')
      : result.errorMessage?.slice(0, 1000) ?? t('socialSchedule.storageUnavailable');
    const finished = await changeSchedule(db, receipt!, { ...receipt!.outputs, targets: receipt!.outputs.targets.map(target => target.targetId === targetId
      ? { targetId, phase, providerObjectId: result.providerObjectId ?? null, permalinkUrl: result.permalinkUrl ?? null,
        confirmedAt: result.ok ? new Date().toISOString() : null, errorCode: result.errorCode?.slice(0, 100) ?? null, errorMessage } : target) }, {}, completionSignal);
    if (!finished) return scheduleFailure('awaitingConfirmation');
    receipt = finished;
    return { ...result, errorMessage };
  };
  try {
    await runPublishNow(boundedClient(db, signal), receipt.family_id, receipt.inputs.postId, actor.userId, { publishTarget });
  } catch {
    // Private provider receipts survive a failed public result/target/final write.
    // Pending or dispatching targets leave the whole attempt held for review.
  }
  const unknown = receipt.outputs.targets.some(target => ['pending', 'dispatching', 'unknown'].includes(target.phase));
  const retryable = !unknown && receipt.attempt < 3 && receipt.outputs.targets.some(target => target.errorCode === 'rate_limited');
  const allPublished = receipt.outputs.targets.every(target => target.phase === 'published');
  const phase = unknown ? 'unknown' : retryable ? 'queued' : allPublished ? 'completed' : 'failed';
  const finished = await changeSchedule(db, receipt, { ...receipt.outputs, phase, reconcile: true,
    retryAt: retryable ? new Date(Date.now() + 300_000 * 2 ** (receipt.attempt - 1)).toISOString() : null },
    { state: allPublished ? 'succeeded' : unknown || retryable ? 'reserved' : 'failed', error: unknown ? t('socialSchedule.awaitingConfirmation') : null,
      errorKey: unknown ? 'socialSchedule.awaitingConfirmation' : null }, completionSignal);
  if (!finished) return scheduleFailure('awaitingConfirmation');
  await reconcileScheduledPost(db, finished, completionSignal).catch(() => undefined);
  return receiptOutcome(finished);
}

export async function publishScheduledPostNow(postId: string): Promise<PublishOutcome | null> {
  const db = createServiceClient(), { familyId, actor } = await requestScheduleActor();
  const receipt = await readSchedule(db, scheduleIdentity(familyId, postId).id);
  if (!receipt) return null;
  await checkScheduleActor(db, familyId, actor, 'publish_posts');
  return executeScheduled(db, receipt, actor, true, AbortSignal.timeout(70_000));
}

export async function runScheduledPublishDrain(options: { now?: Date; signal?: AbortSignal } = {}): Promise<{ inspected: number; attempted: number; published: number; pending: number; unknown: number; failed: number }> {
  const db = createServiceClient(), now = options.now ?? new Date();
  // Stop dispatch at70s and all finalization at100s, within the110s route limit.
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(70_000)]) : AbortSignal.timeout(70_000);
  const completionSignal = AbortSignal.timeout(100_000);
  const summary = { inspected: 0, attempted: 0, published: 0, pending: 0, unknown: 0, failed: 0 };
  const cursorKey = `${SCHEDULE_TOOL}:cursor`;
  const savedCursor = await db.from('app_settings').select('value').eq('key', cursorKey).abortSignal(scheduleSignal(signal)).maybeSingle();
  if (savedCursor.error) return scheduleFailure();
  const value = savedCursor.data?.value;
  let cursor = value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' ? value.id : null;
  if (savedCursor.data && (!cursor || !/^[0-9a-f-]{36}$/i.test(cursor))) return scheduleFailure();
  let wrapped = false;
  const visited = new Set<string>();
  for (let page = 0; page < 20 && !signal.aborted; page += 1) {
    let query = db.from('ai_tool_calls').select('id').eq('tool_name', SCHEDULE_TOOL).contains('outputs', { drain: true }).order('id').limit(1);
    if (cursor) query = query.gt('id', cursor);
    const rows = await query.abortSignal(scheduleSignal(signal));
    if (rows.error || !rows.data) return scheduleFailure();
    if (!rows.data.length) { if (!cursor || wrapped) break; cursor = null; wrapped = true; continue; }
    for (const row of rows.data) {
      if (signal.aborted) break;
      if (visited.has(row.id)) return summary;
      visited.add(row.id);
      cursor = row.id; summary.inspected++;
      try {
        const receipt = await readSchedule(db, row.id, signal);
        if (!receipt) continue;
        // A held receipt remains discoverable if its first presentation write
        // was lost. Wait beyond the operation budget to avoid racing an active
        // pipeline; this repairs display only and never reclaims provider work.
        const heldPresentation = receipt.outputs.phase === 'dispatching' && receipt.locked_at
          && Date.parse(receipt.locked_at) <= now.getTime() - 120_000;
        if (receipt.outputs.reconcile && (receipt.outputs.phase !== 'dispatching' || heldPresentation)) await reconcileScheduledPost(db, receipt, signal);
        if (receipt.outputs.phase !== 'queued' || Date.parse(receipt.inputs.scheduledFor) > now.getTime()
          || (receipt.outputs.retryAt && Date.parse(receipt.outputs.retryAt) > now.getTime())) continue;
        const refreshed = await readSchedule(db, receipt.id, signal);
        if (!refreshed) continue;
        summary.attempted++;
        const outcome = await executeScheduled(db, refreshed, refreshed.inputs.actor, false, signal, now, completionSignal);
        if (outcome.status === 'published') summary.published++;
        else if (outcome.status === 'publishing') summary.unknown++;
        else if ((await readSchedule(db, refreshed.id, completionSignal))?.outputs.phase === 'queued') summary.pending++;
        else summary.failed++;
      } catch (error) {
        summary.failed++;
        // A failed required read is visible and retryable. Revoked or changed
        // authority is held; an ordinary future tick cannot invent new consent.
        const current = await readSchedule(db, row.id, completionSignal).catch(() => null);
        if (current?.outputs.phase === 'queued') {
          const key = error instanceof ScheduledPublishError ? error.key : 'socialSchedule.storageUnavailable';
          const held = key === 'socialSchedule.changed' || key === 'socialSchedule.permissionDenied' || key === 'socialSchedule.reconnectRequired';
          const errorKey = held ? key : key === 'socialSchedule.accessUnavailable' ? key : 'socialSchedule.storageUnavailable';
          const t = await getTranslations();
          const saved = await changeSchedule(db, current, { ...current.outputs, phase: held ? 'failed' : 'queued', reconcile: true },
            { state: held ? 'failed' : current.state, error: t(errorKey), errorKey }, completionSignal).catch(() => null);
          if (saved) await reconcileScheduledPost(db, saved, completionSignal).catch(() => undefined);
        }
      }
      finally {
        const stored = await db.from('app_settings').upsert({ key: cursorKey, value: { id: cursor } }, { onConflict: 'key' }).select('key').abortSignal(scheduleSignal(completionSignal)).maybeSingle();
        if (stored.error || stored.data?.key !== cursorKey) scheduleFailure();
      }
    }
  }
  return summary;
}
