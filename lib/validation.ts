// Shared Zod schemas — used by both client forms and server routes so validation
// rules live in exactly one place.
import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');

// What's this about? — drives the support-ticket category + subject so the team
// can triage web contacts (bug reports, feature requests, billing, etc.).
// `label` stays the English source of truth — the admin support-tickets view and
// the API route read it, and a non-UI caller wants a real string, not a raw key.
// `labelKey` is what the public contact form renders through t(), so a visitor
// picks their topic in their own language.
export const CONTACT_TOPICS = [
  { value: 'general', label: 'General question', labelKey: 'contactTopic.general' },
  { value: 'bug', label: 'Bug report — something’s broken', labelKey: 'contactTopic.bug' },
  { value: 'feature', label: 'Feature request / enhancement', labelKey: 'contactTopic.feature' },
  { value: 'billing', label: 'Billing & subscriptions', labelKey: 'contactTopic.billing' },
  { value: 'account', label: 'Account & login help', labelKey: 'contactTopic.account' },
  { value: 'feedback', label: 'Feedback or a suggestion', labelKey: 'contactTopic.feedback' },
  { value: 'partnership', label: 'Partnership or press', labelKey: 'contactTopic.partnership' },
  { value: 'other', label: 'Something else', labelKey: 'contactTopic.other' },
] as const;
export const CONTACT_TOPIC_VALUES = CONTACT_TOPICS.map((t) => t.value);
export function contactTopicLabel(value: string | null | undefined): string {
  return CONTACT_TOPICS.find((t) => t.value === value)?.label ?? 'General question';
}

export const contactSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(120),
  email: emailSchema,
  topic: z.enum(['general', 'bug', 'feature', 'billing', 'account', 'feedback', 'partnership', 'other']).default('general'),
  message: z.string().trim().min(10, 'Please add a little more detail').max(4000),
});
export type ContactInput = z.infer<typeof contactSchema>;

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter your name').max(120),
  email: emailSchema,
  password: z.string().min(8, 'Use at least 8 characters').max(72),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
});

export const createFamilySchema = z.object({
  name: z.string().trim().min(2, 'Give your family a name').max(80),
  timezone: z.string().min(1).default('UTC'),
});

export const onboardingProfileSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name').max(60),
  lastName: z.string().trim().min(1, 'Enter your last name').max(60),
  // Phone is optional — international E.164 format (+{dialCode}{localDigits}), or empty.
  phone: z.string().max(20).optional().default(''),
  email: emailSchema,
  // data: URI (preset) or Supabase Storage public URL, or empty.
  avatarUrl: z.string().max(5000).optional().default(''),
});
export type OnboardingProfileInput = z.infer<typeof onboardingProfileSchema>;

// Editing your account profile later (Settings) — email stays managed by auth,
// so only the name + contact phone are editable here.
export const profileUpdateSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name').max(60),
  lastName: z.string().trim().min(1, 'Enter your last name').max(60),
  phone: z.string().trim().max(30).optional().default(''),
  avatarUrl: z.string().max(5000).optional().default(''),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

// "About your family" onboarding step — household makeup, goals, attribution.
// The base (no familyId) is reused by the single finalize action, which creates
// the family and these details together; the extended one is for later edits
// where a family already exists.
export const familyDetailsBaseSchema = z.object({
  householdAdults: z.coerce.number().int().min(0).max(20).default(1),
  householdChildren: z.coerce.number().int().min(0).max(20).default(0),
  childAges: z.array(z.number().int().min(0).max(21)).max(20).default([]),
  region: z.string().trim().max(80).optional().default(''),
  postalCode: z.string().trim().max(16).optional().default(''),
  country: z.string().trim().max(80).optional().default(''),
  goals: z.array(z.string()).max(20).default([]),
  referralSource: z.string().trim().max(40).optional().default(''),
  referralDetail: z.string().trim().max(200).optional().default(''),
});
export const familyDetailsSchema = familyDetailsBaseSchema.extend({
  familyId: z.string().uuid('Missing family'),
});
export type FamilyDetailsInput = z.infer<typeof familyDetailsSchema>;

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(['adult', 'teen', 'caregiver', 'guest']),
});

export const inviteMemberActionSchema = inviteSchema.extend({
  familyId: z.string().uuid('Missing family'),
});

export const localMemberActionSchema = z.object({
  familyId: z.string().uuid('Missing family'),
  displayName: z.string().trim().min(1, 'Name is required').max(60),
  role: z.enum(['child', 'teen', 'adult']),
  color: z.string().trim().max(9).optional(),
});

// A family member captured during onboarding. `local` = managed profile with NO
// email/login (any role, so parents can add kids, grandparents, caregivers who
// don't have an email); `invite` = an email join link will be sent.
export const draftMemberSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    name: z.string().trim().min(1, 'Enter a name').max(60),
    role: z.enum(['adult', 'teen', 'child', 'caregiver', 'guest']),
    birthday: z.string().trim().max(10).optional().default(''),
    color: z.string().trim().max(9).optional(),
  }),
  z.object({
    kind: z.literal('invite'),
    email: emailSchema,
    role: z.enum(['adult', 'teen', 'caregiver', 'guest']),
  }),
]);
export type DraftMemberInput = z.infer<typeof draftMemberSchema>;

// The account holder's personal touches captured during onboarding: avatar,
// age, member colour, and an optional 4-digit App Lock PIN. All optional — the
// journey must never block on them.
export const onboardingAppearanceSchema = z.object({
  color: z.string().trim().max(9).optional(),
  age: z.coerce.number().int().min(1).max(120).nullable().optional(),
  avatarUrl: z.string().max(5000).optional().default(''),
  pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits').optional(),
});
export type OnboardingAppearanceInput = z.infer<typeof onboardingAppearanceSchema>;

// The relaxed profile the finalize action accepts: only a first name is truly
// required. Last name + email default to '' (the action falls back to the
// signed-in email), so the world-class wizard can reach first value fast without
// forcing a last name or a second email entry.
export const onboardingFinalizeProfileSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your name').max(60),
  lastName: z.string().trim().max(60).optional().default(''),
  phone: z.string().max(20).optional().default(''),
  email: z.union([emailSchema, z.literal('')]).optional().default(''),
  avatarUrl: z.string().max(5000).optional().default(''),
});

// The ENTIRE onboarding journey, committed in one atomic server action only when
// the user reaches the end. Abandoning before this writes nothing — so a bailed
// journey never leaves a half-created account/family behind.
// One imported calendar event from the value step (paste .ics or the sample
// week). Deliberately minimal + bounded — only what the timeline/first-brief
// needs — so a giant paste can't smuggle arbitrary data into finalize.
export const importedEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  start: z.string().min(1).max(40),
  end: z.string().max(40).nullable().optional(),
  allDay: z.boolean().optional(),
  location: z.string().max(200).nullable().optional(),
  recurring: z.boolean().optional(),
});

export const onboardingCalendarImportSchema = z.object({
  source: z.enum(['ics', 'paste', 'url', 'demo', '']).optional().default(''),
  events: z.array(importedEventSchema).max(1000).optional().default([]),
  receipt: z.string().max(150_000).optional(),
});

export const previewCalendarImportSchema = z.object({
  source: z.enum(['paste', 'demo']),
  icsText: z.string().max(200_000).optional(),
});

export const completeProfileOnboardingSchema = z.object({
  firstName: z.string().trim().min(1, 'Please add your name.').max(60),
  age: z.preprocess(
    (value) => value === '' ? null : value,
    z.coerce.number().int().min(1).max(120).nullable().optional(),
  ),
  avatarUrl: z.string().max(5000).optional(),
  color: z.string().trim().max(9).optional(),
  pin: z.string().regex(/^\d{4}$/, 'Your PIN must be 4 digits.').optional(),
});

// The ENTIRE onboarding journey, committed in one atomic server action only when
// the user reaches the end. Abandoning before this writes nothing — so a bailed
// journey never leaves a half-created account/family behind.
export const finalizeOnboardingSchema = z.object({
  profile: onboardingFinalizeProfileSchema,
  family: createFamilySchema,
  details: familyDetailsBaseSchema,
  members: z.array(draftMemberSchema).max(30).default([]),
  appearance: onboardingAppearanceSchema.optional().default({}),
  calendarImport: onboardingCalendarImportSchema.optional().default({ source: '', events: [] }),
});
export type FinalizeOnboardingInput = z.infer<typeof finalizeOnboardingSchema>;

export const eventSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  starts_at: z.string().min(1, 'Pick a start time'),
  ends_at: z.string().optional().nullable(),
  category: z.enum([
    'general', 'school', 'sports', 'appointment', 'medication',
    'maintenance', 'birthday', 'holiday', 'other',
  ]).default('general'),
  location: z.string().max(200).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
});

export const choreSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  points: z.coerce.number().int().min(0).max(1000).default(10),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  due_at: z.string().optional().nullable(),
  member_id: z.string().uuid().optional().nullable(),
});

/** Format a ZodError into a flat { field: message } map for forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
