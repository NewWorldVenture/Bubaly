import { z } from 'zod';

/** A current-screen consistency assertion; never an authority or draft field. */
export const onboardingOwnerSchema = z.object({ userId: z.string().guid(), familyId: z.string().guid().nullable() }).strict();
export type OnboardingOwner = z.infer<typeof onboardingOwnerSchema>;
