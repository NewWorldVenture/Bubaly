import { z } from 'zod';

/** A current-screen consistency assertion; never an authority or draft field. */
export const onboardingOwnerSchema = z.object({ userId: z.string().uuid(), familyId: z.string().uuid().nullable() }).strict();
export type OnboardingOwner = z.infer<typeof onboardingOwnerSchema>;
