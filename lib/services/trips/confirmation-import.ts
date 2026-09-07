import 'server-only';
import { settleAll } from '@/lib/supabase/settle';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FEATURE_CATALOG_BY_KEY } from '@/lib/constants/feature-catalog';
import { planLevel } from '@/lib/constants/plans';
import { tierToLevel } from '@/lib/features/tiers';
import { computeEntitlement } from '@/lib/server/entitlement';
import { fail, ok, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import {
  confirmationSourceSchema, confirmationFieldsSchema, confirmationPreviewSchema,
  confirmationResultSchema, sameConfirmationValue, type ConfirmationSource, type ConfirmationFields,
  type ConfirmationPreview, type ConfirmationResult,
} from '@/lib/vacations/confirmation-import';

const uuid = z.string().uuid();
const previewInputSchema = z.object({
  vacationId: uuid,
  source: confirmationSourceSchema,
  fields: confirmationFieldsSchema,
}).strict();
const applyInputSchema = previewInputSchema.extend({
  expected: confirmationPreviewSchema,
  requestId: uuid,
}).strict();

type PreviewInput = {
  vacationId: string;
  source: ConfirmationSource;
  fields: ConfirmationFields;
};
type ApplyInput = PreviewInput & { expected: ConfirmationPreview; requestId: string };
type RpcArgs = {
  p_family_id: string;
  p_vacation_id: string;
  p_member_id: string;
  p_source: ConfirmationSource;
  p_fields: ConfirmationFields;
  p_expected: ConfirmationPreview | null;
  p_request_id: string | null;
};

const unavailable = () => fail(
  'Confirmation import is temporarily unavailable. Retry a save with the same request ID.',
  { code: 'db', retryable: true },
);
const denied = () => fail('An active parent or adult in the selected family is required.', { code: 'denied' });
const invalid = () => fail('The confirmation import or reviewed preview is invalid.', { code: 'invalid_input' });

const dbTimestamp = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.getUTCFullYear() >= 1 && at.getUTCFullYear() <= 9999;
});
const memberSchema = z.object({
  id: uuid, family_id: uuid, user_id: uuid,
  role: z.enum(['parent', 'adult']), is_active: z.literal(true),
}).strict();
const familySchema = z.object({
  id: uuid, trial_ends_at: dbTimestamp.nullable(), closed_at: dbTimestamp.nullable(),
}).strict();
const subscriptionsSchema = z.array(z.object({
  family_id: uuid,
  plan: z.enum(['free', 'family', 'family_annual', 'basic', 'basic_annual', 'plus', 'plus_annual']),
  status: z.enum(['active', 'trialing']),
}).strict());
const settingsSchema = z.object({
  value: z.record(z.enum(['off', 'free', 'basic', 'plus'])),
}).strict();

/** Fresh reads through the supplied authenticated client, including receipt retries. */
async function authorize(scope: ServiceScope): Promise<ServiceResult<void>> {
  const { userId, memberId, familyId } = scope;
  if (!userId || !memberId || ![userId, memberId, familyId].every((id) => uuid.safeParse(id).success)
    || !['parent', 'adult'].includes(scope.role)
    || !['member', 'ai'].includes(scope.actorKind)) return denied();

  const auth = await scope.db.auth.getUser();
  if (auth.error || !auth.data.user) {
    if (!auth.error || auth.error.name === 'AuthSessionMissingError' || auth.error.code === 'session_missing') {
      return fail('Sign in to review a travel confirmation.', { code: 'unauthorized' });
    }
    return unavailable();
  }
  if (auth.data.user.id !== userId) return denied();

  const [membership, preferences, family, subscriptions, settings] = await settleAll([
    scope.db.from('family_members').select('id, family_id, user_id, role, is_active')
      .eq('id', memberId).eq('family_id', familyId).eq('user_id', userId).eq('is_active', true).maybeSingle(),
    scope.db.from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle(),
    scope.db.from('families').select('id, trial_ends_at, closed_at').eq('id', familyId).maybeSingle(),
    scope.db.from('subscriptions').select('family_id, plan, status').eq('family_id', familyId)
      .in('status', ['active', 'trialing']),
    scope.db.from('app_settings').select('value').eq('key', 'feature_tiers').maybeSingle(),
  ]);
  if ([membership, preferences, family, subscriptions, settings].some((result) => result.error)) return unavailable();

  const member = memberSchema.safeParse(membership.data);
  if (!member.success || member.data.id !== memberId || member.data.family_id !== familyId
    || member.data.user_id !== userId || member.data.role !== scope.role
    || preferences.data?.active_family_id !== familyId) return denied();

  const currentFamily = familySchema.safeParse(family.data);
  const currentSubscriptions = subscriptionsSchema.safeParse(subscriptions.data);
  const currentSettings = settingsSchema.safeParse(settings.data);
  if (!currentFamily.success || currentFamily.data.id !== familyId
    || !currentSubscriptions.success || !currentSettings.success
    || currentSubscriptions.data.some((sub) => sub.family_id !== familyId)) return unavailable();

  // The current catalog calls the travel feature "trips"; vacations is its data/UI surface.
  const feature = FEATURE_CATALOG_BY_KEY.trips;
  if (!feature) return unavailable();
  const tier = currentSettings.data.value[feature.key] ?? feature.defaultTier;
  const requiredLevel = tierToLevel(tier);
  const entitlement = computeEntitlement({
    paidLevel: currentSubscriptions.data.reduce((level, sub) => Math.max(level, planLevel(sub.plan)), 0),
    trialEndsAt: currentFamily.data.trial_ends_at,
    closedAt: currentFamily.data.closed_at,
  });
  if (requiredLevel < 0 || entitlement.locked || entitlement.closed || entitlement.effectiveLevel < requiredLevel) {
    return fail('Travel confirmation import is not available with the current family settings and plan.', { code: 'denied' });
  }
  return ok(undefined);
}

function supportedInstant(value: string): boolean {
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.getUTCFullYear() >= 1 && at.getUTCFullYear() <= 9999;
}

function realDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(value + 'T00:00:00Z');
  return supportedInstant(value + 'T00:00:00Z') && at.toISOString().slice(0, 10) === value;
}

function matchesPreview(
  preview: ConfirmationPreview, scope: ServiceScope, input: PreviewInput, hash: string,
): boolean {
  if (preview.version !== 1 || preview.familyId !== scope.familyId || preview.memberId !== scope.memberId
    || preview.vacationId !== input.vacationId || preview.trip.id !== input.vacationId
    || !sameConfirmationValue(preview.source, { ...input.source, sha256: hash })
    || !sameConfirmationValue(preview.fields, input.fields)
    || !supportedInstant(input.fields.reservedAt)
    || !realDay(preview.trip.startDate) || !realDay(preview.trip.endDate)
    || preview.trip.startDate > preview.trip.endDate
    || !['planning', 'booked', 'active', 'completed'].includes(preview.trip.status)
    || !dbTimestamp.safeParse(preview.trip.updatedAt).success) return false;
  try {
    // h23 and explicit calendar/numerals keep midnight and early years unambiguous.
    // The Gregorian calendar supplies the era; ISO 8601 can omit it even when requested.
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      calendar: 'gregory', numberingSystem: 'latn', timeZone: preview.trip.timezone,
      era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(input.fields.reservedAt)).map((part) => [part.type, part.value]));
    const year = Number(parts.year);
    if (parts.era !== 'AD' || year < 1 || year > 9999) return false;
    const date = parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day;
    const startTime = parts.hour + ':' + parts.minute + ':' + parts.second;
    const hour = Number(parts.hour);
    const dayPart = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    return realDay(date) && date >= preview.trip.startDate && date <= preview.trip.endDate
      && sameConfirmationValue(preview.itinerary, { date, startTime, dayPart });
  } catch {
    return false;
  }
}

function rpcFailure(code: string | undefined): ServiceResult<never> {
  switch (code) {
    case '22023': return invalid();
    case '42501': return denied();
    case '28000': return fail('Sign in to review a travel confirmation.', { code: 'unauthorized' });
    case 'P0002': return fail('The selected trip is unavailable.', { code: 'not_found' });
    case '55000':
      return fail('Review the trip status, dates, and timezone before importing.', { code: 'conflict' });
    case '40001':
      return fail('The trip changed. Review a new preview before saving.', { code: 'conflict' });
    case '23505':
      return fail('This source or request has already been used. Review the existing import.', { code: 'conflict' });
    default: return unavailable();
  }
}

async function importConfirmation(
  scope: ServiceScope, input: PreviewInput | ApplyInput, apply: boolean,
): Promise<ServiceResult<ConfirmationResult>> {
  if (apply && scope.actorKind !== 'member') return denied();
  try {
    let normalized: PreviewInput;
    let approval: ConfirmationPreview | null = null;
    let requestId: string | null = null;
    if (apply) {
      const parsed = applyInputSchema.safeParse(input);
      if (!parsed.success || !sameConfirmationValue(input, parsed.data)) return invalid();
      normalized = parsed.data;
      approval = parsed.data.expected;
      requestId = parsed.data.requestId;
    } else {
      const parsed = previewInputSchema.safeParse(input);
      if (!parsed.success) return invalid();
      normalized = parsed.data;
    }
    if (!supportedInstant(normalized.fields.reservedAt)) return invalid();
    const hash = createHash('sha256').update(normalized.source.text, 'utf8').digest('hex');
    if (approval && !matchesPreview(approval, scope, normalized, hash)) return invalid();

    const permission = await authorize(scope);
    if (!permission.ok) return permission;
    // This fixed signature also permits the independent worker to precede generated DB types.
    const rpc = scope.db.rpc.bind(scope.db) as unknown as (
      name: 'vacation_import_confirmation', args: RpcArgs,
    ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
    const response = await rpc('vacation_import_confirmation', {
      p_family_id: scope.familyId,
      p_vacation_id: normalized.vacationId,
      p_member_id: scope.memberId!,
      p_source: normalized.source,
      p_fields: normalized.fields,
      p_expected: approval,
      p_request_id: requestId,
    });
    if (response.error) return rpcFailure(response.error.code);

    const result = confirmationResultSchema.safeParse(response.data);
    if (!result.success || !sameConfirmationValue(response.data, result.data)
      || !matchesPreview(result.data.preview, scope, normalized, hash)) return unavailable();
    const receipt = result.data;
    if (apply) {
      // Do not take a fresh preview here: a lost-response replay returns the original
      // approved receipt even when the trip has subsequently changed.
      if (!receipt.applied || receipt.requestId !== requestId
        || !dbTimestamp.safeParse(receipt.appliedAt).success
        || !uuid.safeParse(receipt.reservationId).success || !uuid.safeParse(receipt.itineraryItemId).success
        || !sameConfirmationValue(receipt.preview, approval)) return unavailable();
    } else if (receipt.applied || receipt.requestId !== null || receipt.appliedAt !== null
      || receipt.reservationId !== null || receipt.itineraryItemId !== null) return unavailable();
    return ok(receipt);
  } catch {
    // Transport errors can follow a committed save. Never invent success or retry
    // with a new UUID, and never log the private source or database response.
    return unavailable();
  }
}

export async function previewConfirmationImport(
  scope: ServiceScope, input: PreviewInput,
): Promise<ServiceResult<ConfirmationResult>> {
  return importConfirmation(scope, input, false);
}

export async function applyConfirmationImport(
  scope: ServiceScope, input: ApplyInput,
): Promise<ServiceResult<ConfirmationResult>> {
  return importConfirmation(scope, input, true);
}
