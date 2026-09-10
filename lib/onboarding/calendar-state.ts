import 'server-only';
import { z } from 'zod';
import { encryptSecret, decryptSecret } from '@/lib/sync/crypto';
import { onboardingRunKey } from '@/lib/onboarding/idempotency';
import type { BriefEvent } from '@/lib/onboarding/first-brief';
import { isReviewPlan, type ReviewPlan } from '@/lib/billing/review-selection';

export type OnboardingCalendarProvider = 'google' | 'microsoft';
export const onboardingCalendarProvider = z.enum(['google', 'microsoft']);
export const calendarContinuationCookie = (provider: string) => `onboarding_calendar_${provider}`;
const canonicalCiphertext = (value: string) => {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0 && Buffer.from(part, 'base64').toString('base64') === part);
};
const continuationSchema = z.object({
  version: z.literal(1), kind: z.literal('onboarding_calendar'), userId: z.string().uuid(), familyId: z.string().uuid(),
  provider: onboardingCalendarProvider, state: z.string().min(20).max(100), expiresAt: z.number().finite(),
  reviewPlan: z.custom<ReviewPlan>(isReviewPlan).optional(),
});
export type CalendarContinuation = z.infer<typeof continuationSchema>;
export function sealCalendarContinuation(input: Omit<CalendarContinuation, 'version' | 'kind' | 'expiresAt'>, now = Date.now()): string {
  return encryptSecret(JSON.stringify({ ...input, version: 1, kind: 'onboarding_calendar', expiresAt: now + 600_000 }));
}
export function readCalendarContinuation(value: string | undefined, now = Date.now()): CalendarContinuation | null {
  try {
    if (!value || value.length > 4000 || !canonicalCiphertext(value)) return null;
    const result = continuationSchema.safeParse(JSON.parse(decryptSecret(value)));
    return result.success && result.data.expiresAt > now && result.data.expiresAt <= now + 600_000 ? result.data : null;
  } catch { return null; }
}

const receiptSchema = z.object({
  version: z.literal(1), kind: z.literal('onboarding_calendar_preview'), userId: z.string().uuid(), familyId: z.string().uuid(),
  accountId: z.string().uuid(), provider: onboardingCalendarProvider, calendarExternalId: z.string().min(1).max(2000),
  eventKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000), digest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().finite(),
});
export type CalendarPreviewReceipt = z.infer<typeof receiptSchema>;
export function sealCalendarPreview(input: Omit<CalendarPreviewReceipt, 'version' | 'kind' | 'expiresAt' | 'digest'>, events: BriefEvent[], now = Date.now()): string {
  return encryptSecret(JSON.stringify({ ...input, version: 1, kind: 'onboarding_calendar_preview',
    digest: onboardingRunKey(input.userId, events), expiresAt: now + 24 * 60 * 60_000 }));
}
export function readCalendarPreview(value: string | undefined, userId: string, events: BriefEvent[], now = Date.now()): CalendarPreviewReceipt | null {
  try {
    if (!value || value.length > 150_000 || !canonicalCiphertext(value)) return null;
    const result = receiptSchema.safeParse(JSON.parse(decryptSecret(value)));
    if (!result.success) return null;
    const data = result.data;
    return data.userId === userId && data.expiresAt > now && data.expiresAt <= now + 24 * 60 * 60_000 &&
      data.eventKeys.length === events.length && data.digest === onboardingRunKey(userId, events) ? data : null;
  } catch { return null; }
}
