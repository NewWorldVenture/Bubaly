import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { ROLE_PERMISSIONS, defaultSocialRoleForMember, isSocialRole } from './roles';
import type { ConnectorPublishInput, ConnectorPublishOutput } from './connectors';

export class ScheduledPublishError extends Error {
  constructor(public readonly key: string) { super(key); this.name = 'ScheduledPublishError'; }
}
export function scheduleFailure(key = 'storageUnavailable'): never { throw new ScheduledPublishError(`socialSchedule.${key}`); }
export const SCHEDULE_TOOL = 'social.scheduled_publish';
export type ScheduleDb = SupabaseClient<Database>;
const uuid = z.string().uuid();
const actorSchema = z.object({ userId: uuid, memberId: uuid }).strict();
const targetSchema = z.object({ id: uuid, accountId: uuid, platform: z.literal('x'), providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict();
const snapshotSchema = z.object({
  kind: z.enum(['text', 'link']), body: z.string().max(100_000), link: z.string().max(4096).nullable(),
  variants: z.array(z.object({ id: uuid, platform: z.literal('x'), body: z.string().max(100_000) }).strict()).max(1),
  targets: z.array(targetSchema).min(1).max(10), calendarIds: z.array(uuid).length(1),
}).strict();
const inputSchema = z.object({
  version: z.literal(1), familyId: uuid, postId: uuid, scheduleId: uuid, actor: actorSchema,
  scheduledFor: z.string().datetime(), timezone: z.string().min(1).max(100), authorizedAt: z.string().datetime(),
  approvalRequired: z.boolean(), snapshot: snapshotSchema,
}).strict();
const resultSchema = z.object({
  targetId: uuid, phase: z.enum(['pending', 'dispatching', 'published', 'failed', 'skipped', 'unknown']),
  providerObjectId: z.string().max(128).nullable(), permalinkUrl: z.string().max(4096).nullable(),
  confirmedAt: z.string().datetime().nullable(),
  errorCode: z.string().max(100).nullable(), errorMessage: z.string().max(1000).nullable(),
}).strict();
const outputSchema = z.object({
  version: z.literal(1), revision: uuid,
  phase: z.enum(['unarmed', 'queued', 'approval_required', 'dispatching', 'completed', 'failed', 'unknown']),
  actor: actorSchema.nullable(), targets: z.array(resultSchema).min(1).max(10),
  retryAt: z.string().datetime().nullable(), reconcile: z.boolean(), drain: z.boolean(),
  errorKey: z.enum(['socialSchedule.storageUnavailable', 'socialSchedule.accessUnavailable', 'socialSchedule.permissionDenied',
    'socialSchedule.changed', 'socialSchedule.reconnectRequired', 'socialSchedule.approvalRequired', 'socialSchedule.awaitingConfirmation']).nullable(),
}).strict();
export type ScheduleActor = z.infer<typeof actorSchema>;
export type ScheduleInputs = z.infer<typeof inputSchema>;
export type ScheduleOutputs = z.infer<typeof outputSchema>;
export type ScheduleReceipt = Omit<Tables<'ai_tool_calls'>, 'inputs' | 'outputs'> & { inputs: ScheduleInputs; outputs: ScheduleOutputs };
export type ScheduledClaim = { receiptId: string; revision: string; targetId: string };
export type ScheduleExpected = { kind: string; body: string; link: string | null; accountIds: string[] };

export function scheduleIdentity(familyId: string, postId: string) {
  const key = `${SCHEDULE_TOOL}:v1:${familyId}:${postId}`;
  const hex = createHash('sha256').update(key).digest('hex');
  return { key, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` };
}
export function scheduleSignal(signal?: AbortSignal): AbortSignal {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  // The installed PostgREST SDK retries TimeoutError GETs. A deadline must
  // terminate the operation, including its retries, with AbortError instead.
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Scheduled publishing deadline exceeded', 'AbortError'));
  if (deadline.aborted) abort(); else deadline.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
export function validateSchedule(row: Tables<'ai_tool_calls'>): ScheduleReceipt {
  const parsedInputs = inputSchema.safeParse(row.inputs), parsedOutputs = outputSchema.safeParse(row.outputs);
  if (!parsedInputs.success || !parsedOutputs.success) return scheduleFailure();
  const inputs = parsedInputs.data, outputs = parsedOutputs.data, identity = scheduleIdentity(inputs.familyId, inputs.postId);
  if (row.id !== identity.id || row.idempotency_key !== identity.key || row.family_id !== inputs.familyId
    || row.tool_name !== SCHEDULE_TOOL || row.actor_kind !== 'system' || row.resource_table !== 'social_posts' || row.resource_id !== inputs.postId
    || [row.requested_by, row.requested_by_member_id, row.run_id, row.plan_step_id, row.request_id, row.conversation_id, row.message_id].some(value => value !== null)
    || !Number.isInteger(row.attempt) || row.attempt < 0 || row.attempt > 3
    || !['reserved', 'succeeded', 'failed'].includes(row.state)
    || outputs.targets.length !== inputs.snapshot.targets.length
    || outputs.targets.some((target, i) => target.targetId !== inputs.snapshot.targets[i].id)) return scheduleFailure();
  return { ...row, inputs, outputs };
}
export async function readSchedule(db: ScheduleDb, id: string, signal?: AbortSignal): Promise<ScheduleReceipt | null> {
  try {
    const result = await db.from('ai_tool_calls').select('*').eq('id', id).abortSignal(scheduleSignal(signal)).maybeSingle();
    if (result.error) return scheduleFailure();
    return result.data ? validateSchedule(result.data) : null;
  } catch (error) { if (error instanceof ScheduledPublishError) throw error; return scheduleFailure(); }
}
export async function changeSchedule(db: ScheduleDb, row: ScheduleReceipt, outputs: ScheduleOutputs,
  options: { attempt?: number; state?: ScheduleReceipt['state']; error?: string | null; errorKey?: ScheduleOutputs['errorKey'] } = {}, signal?: AbortSignal): Promise<ScheduleReceipt | null> {
  try {
    const next = outputSchema.parse({ ...outputs, revision: randomUUID(),
      errorKey: options.errorKey !== undefined ? options.errorKey : outputs.phase === 'approval_required' ? 'socialSchedule.approvalRequired'
        : ['unknown', 'dispatching'].includes(outputs.phase) ? 'socialSchedule.awaitingConfirmation' : outputs.errorKey,
      drain: outputs.phase === 'queued' || outputs.reconcile });
    const result = await db.from('ai_tool_calls').update({ outputs: next, attempt: options.attempt ?? row.attempt,
      state: options.state ?? row.state, error: options.error ?? null,
      locked_at: next.phase === 'dispatching' ? new Date().toISOString() : row.locked_at,
      finished_at: ['completed', 'failed', 'approval_required'].includes(next.phase) ? new Date().toISOString() : null,
    }).eq('id', row.id).eq('family_id', row.family_id).eq('tool_name', SCHEDULE_TOOL).eq('state', row.state)
      .contains('outputs', { revision: row.outputs.revision }).abortSignal(scheduleSignal(signal)).select('*').maybeSingle();
    if (result.error) return scheduleFailure();
    return result.data ? validateSchedule(result.data) : null;
  } catch (error) { if (error instanceof ScheduledPublishError) throw error; return scheduleFailure(); }
}

/** Successful absence uses the existing setting default; failed reads never do. */
export async function needsPublishApproval(db: ScheduleDb, familyId: string, approvalStatus: unknown, signal?: AbortSignal): Promise<boolean> {
  try {
    const settings = await db.from('social_settings').select('family_id,require_approval').eq('family_id', familyId)
      .abortSignal(scheduleSignal(signal)).maybeSingle();
    if (settings.error || (settings.data && (settings.data.family_id !== familyId || typeof settings.data.require_approval !== 'boolean'))) return scheduleFailure('accessUnavailable');
    if (!['not_required', 'pending', 'approved', 'rejected', 'changes_requested'].includes(String(approvalStatus))) return scheduleFailure('accessUnavailable');
    return settings.data?.require_approval === true || approvalStatus !== 'not_required';
  } catch (error) { if (error instanceof ScheduledPublishError) throw error; return scheduleFailure('accessUnavailable'); }
}

/** Identity comes only from a fresh request or a server-written receipt. */
export async function checkScheduleActor(db: ScheduleDb, familyId: string, actor: ScheduleActor,
  permission: 'schedule_posts' | 'publish_posts', signal?: AbortSignal): Promise<void> {
  try {
    const [member, explicit] = await Promise.all([
      db.from('family_members').select('id,family_id,user_id,role,is_active').eq('id', actor.memberId)
        .eq('family_id', familyId).eq('user_id', actor.userId).eq('is_active', true).abortSignal(scheduleSignal(signal)).maybeSingle(),
      db.from('social_access_permissions').select('family_id,user_id,status,social_role').eq('family_id', familyId)
        .eq('user_id', actor.userId).eq('status', 'active').abortSignal(scheduleSignal(signal)).maybeSingle(),
    ]);
    if (member.error || explicit.error) return scheduleFailure('accessUnavailable');
    if (!member.data || member.data.id !== actor.memberId || member.data.family_id !== familyId || member.data.user_id !== actor.userId || member.data.is_active !== true) return scheduleFailure('permissionDenied');
    if (explicit.data && (explicit.data.family_id !== familyId || explicit.data.user_id !== actor.userId || explicit.data.status !== 'active' || !isSocialRole(explicit.data.social_role))) return scheduleFailure('accessUnavailable');
    const role = explicit.data ? explicit.data.social_role : defaultSocialRoleForMember(member.data.role);
    if (!ROLE_PERMISSIONS[role]?.includes(permission)) return scheduleFailure('permissionDenied');
  } catch (error) { if (error instanceof ScheduledPublishError) throw error; return scheduleFailure('accessUnavailable'); }
}
export async function requestScheduleActor(familyId?: string): Promise<{ familyId: string; actor: ScheduleActor }> {
  try {
    const ctx = await requireUserContext();
    const actor = actorSchema.parse({ userId: ctx.user.id, memberId: ctx.active.member.id });
    if ((familyId && ctx.active.familyId !== familyId) || ctx.active.member.family_id !== ctx.active.familyId || ctx.active.member.user_id !== actor.userId) return scheduleFailure('permissionDenied');
    return { familyId: ctx.active.familyId, actor };
  } catch (error) { if (error instanceof ScheduledPublishError) throw error; return scheduleFailure('permissionDenied'); }
}

export async function readScheduleSnapshot(db: ScheduleDb, input: Pick<ScheduleInputs, 'familyId' | 'postId' | 'scheduleId' | 'scheduledFor' | 'timezone'>,
  signal?: AbortSignal): Promise<{ snapshot: ScheduleInputs['snapshot']; approvalRequired: boolean; post: Tables<'social_posts'> }> {
  try {
    const { familyId, postId, scheduleId, scheduledFor, timezone } = input;
    const sameInstant = (value: string | null) => typeof value === 'string' && Date.parse(value) === Date.parse(scheduledFor);
    const [post, variants, targets, schedules, calendar] = await Promise.all([
      db.from('social_posts').select('*').eq('id', postId).eq('family_id', familyId).is('deleted_at', null).abortSignal(scheduleSignal(signal)).single(),
      db.from('social_post_variants').select('id,platform,body', { count: 'exact' }).eq('post_id', postId).eq('family_id', familyId).order('id').limit(2).abortSignal(scheduleSignal(signal)),
      db.from('social_post_targets').select('id,account_id,platform,scheduled_for', { count: 'exact' }).eq('post_id', postId).eq('family_id', familyId).order('id').limit(11).abortSignal(scheduleSignal(signal)),
      db.from('social_schedules').select('id,scheduled_for,timezone,recurrence', { count: 'exact' }).eq('post_id', postId).eq('family_id', familyId).limit(2).abortSignal(scheduleSignal(signal)),
      db.from('social_calendar_items').select('id,platform,scheduled_for', { count: 'exact' }).eq('post_id', postId).eq('family_id', familyId).order('id').limit(2).abortSignal(scheduleSignal(signal)),
    ]);
    if (post.error || !post.data || [variants, targets, schedules, calendar].some(result => result.error || !result.data || result.count !== result.data.length)) return scheduleFailure();
    if (!sameInstant(post.data.scheduled_for) || schedules.data!.length !== 1 || schedules.data![0].id !== scheduleId
      || !sameInstant(schedules.data![0].scheduled_for) || schedules.data![0].timezone !== timezone || schedules.data![0].recurrence !== 'none'
      || calendar.data!.length !== 1 || calendar.data![0].platform !== 'x' || !sameInstant(calendar.data![0].scheduled_for)
      || !targets.data!.length || targets.data!.length > 10 || targets.data!.some(target => target.platform !== 'x' || !target.account_id || !sameInstant(target.scheduled_for))
      || new Set(targets.data!.map(target => target.account_id)).size !== targets.data!.length) return scheduleFailure('changed');
    const boundTargets: ScheduleInputs['snapshot']['targets'] = [];
    for (const target of targets.data!) {
      const account = await db.from('social_accounts').select('id,family_id,platform,provider_account_id,status,deleted_at').eq('id', target.account_id!)
        .eq('family_id', familyId).abortSignal(scheduleSignal(signal)).single();
      if (account.error || !account.data) return scheduleFailure();
      if (account.data.status !== 'connected' || account.data.deleted_at || account.data.platform !== 'x' || account.data.family_id !== familyId) return scheduleFailure('reconnectRequired');
      boundTargets.push(targetSchema.parse({ id: target.id, accountId: account.data.id, platform: 'x', providerAccountId: account.data.provider_account_id }));
    }
    if (new Set(boundTargets.map(target => target.providerAccountId)).size !== boundTargets.length) return scheduleFailure('changed');
    const snapshot = snapshotSchema.parse({ kind: post.data.kind, body: post.data.body, link: post.data.link,
      variants: variants.data!, targets: boundTargets, calendarIds: calendar.data!.map(item => item.id) });
    return { snapshot, approvalRequired: await needsPublishApproval(db, familyId, post.data.approval_status, signal), post: post.data };
  } catch (error) { if (error instanceof ScheduledPublishError) throw error; return scheduleFailure('changed'); }
}
export async function verifyScheduleSnapshot(db: ScheduleDb, receipt: ScheduleReceipt, signal?: AbortSignal) {
  const current = await readScheduleSnapshot(db, receipt.inputs, signal);
  if (JSON.stringify(current.snapshot) !== JSON.stringify(receipt.inputs.snapshot)) return scheduleFailure('changed');
  return { ...current, approvalRequired: receipt.inputs.approvalRequired || current.approvalRequired };
}

/** Rechecked at private-token access, never a caller-supplied actor bypass. */
export async function authorizeScheduledToken(input: ConnectorPublishInput, claim: ScheduledClaim): Promise<void> {
  const db = createServiceClient(), receipt = await readSchedule(db, claim.receiptId, input.signal);
  if (!receipt || receipt.outputs.phase !== 'dispatching' || receipt.outputs.revision !== claim.revision || !receipt.outputs.actor
    || receipt.outputs.targets.find(target => target.targetId === claim.targetId)?.phase !== 'dispatching') return scheduleFailure('awaitingConfirmation');
  const target = receipt.inputs.snapshot.targets.find(item => item.id === claim.targetId);
  const body = receipt.inputs.snapshot.variants[0]?.body ?? receipt.inputs.snapshot.body;
  if (!target || input.familyId !== receipt.family_id || input.userId !== receipt.outputs.actor.userId || input.accountId !== target.accountId
    || input.platform !== target.platform || input.providerAccountId !== target.providerAccountId || input.body !== body
    || (input.link ?? null) !== receipt.inputs.snapshot.link || input.kind !== receipt.inputs.snapshot.kind || input.mediaUrls.length) return scheduleFailure('changed');
  await checkScheduleActor(db, receipt.family_id, receipt.outputs.actor, 'publish_posts', input.signal);
  const current = await verifyScheduleSnapshot(db, receipt, input.signal);
  if (current.approvalRequired) return scheduleFailure('approvalRequired');
}

export function priorProviderResult(target: ScheduleOutputs['targets'][number]): ConnectorPublishOutput {
  return { ok: target.phase === 'published', status: target.phase === 'unknown' || target.phase === 'dispatching' ? 'publishing' : target.phase === 'pending' ? 'failed' : target.phase,
    providerObjectId: target.providerObjectId, permalinkUrl: target.permalinkUrl,
    errorCode: target.phase === 'unknown' || target.phase === 'dispatching' ? 'confirmation_unknown' : target.errorCode,
    errorMessage: target.errorMessage };
}
