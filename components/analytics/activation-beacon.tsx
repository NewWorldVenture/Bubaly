'use client';

// <ActivationBeacon> — drop into a value-view page (Outcomes, Briefing) to record
// the family reaching that milestone once. Renders nothing; fires on mount. (T10)
import { useEffect } from 'react';
import { trackActivationOnce } from '@/lib/analytics/activation-track';
import type { ActivationMilestone } from '@/lib/analytics/activation';

export function ActivationBeacon({
  milestone, familyId, userId, signupAtIso,
}: {
  milestone: ActivationMilestone;
  familyId: string;
  userId?: string | null;
  signupAtIso?: string | null;
}) {
  useEffect(() => {
    trackActivationOnce({ milestone, familyId, userId, signupAtIso });
  }, [milestone, familyId, userId, signupAtIso]);
  return null;
}
