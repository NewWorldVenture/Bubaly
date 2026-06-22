// Shared Zod schemas — used by both client forms and server routes so validation
// rules live in exactly one place.
import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');

export const contactSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(120),
  email: emailSchema,
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
  phone: z.string().trim().min(7, 'Enter a valid phone number').max(30),
  email: emailSchema,
});
export type OnboardingProfileInput = z.infer<typeof onboardingProfileSchema>;

// Editing your account profile later (Settings) — email stays managed by auth,
// so only the name + contact phone are editable here.
export const profileUpdateSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name').max(60),
  lastName: z.string().trim().min(1, 'Enter your last name').max(60),
  phone: z.string().trim().min(7, 'Enter a valid phone number').max(30),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

// "About your family" onboarding step — household makeup, goals, attribution.
export const familyDetailsSchema = z.object({
  familyId: z.string().uuid('Missing family'),
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
export type FamilyDetailsInput = z.infer<typeof familyDetailsSchema>;

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(['adult', 'teen', 'caregiver', 'guest']),
});

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
