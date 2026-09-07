// lib/grandparent/digest.ts — pure grandparent-portal digest logic.
// Builds a simplified, read-only view of the family for grandparents / elders
// who want to stay connected but don't need the full app complexity.

export type MemberSnapshot = {
  name: string;
  birthday: string | null;
  color: string | null;
  role: string;
};

export type PhotoSnapshot = {
  url: string;
  caption: string | null;
  date: string;
};

export type MilestoneSnapshot = {
  title: string;
  description: string | null;
  date: string;
  memberName: string | null;
};

export type AnnouncementSnapshot = {
  title: string;
  body: string | null;
  authorName: string | null;
  date: string;
};

export type CelebrationSnapshot = {
  title: string;
  date: string;
  daysUntil: number;
};

export type GrandparentDigest = {
  familyName: string;
  members: MemberSnapshot[];
  recentPhotos: PhotoSnapshot[];
  recentMilestones: MilestoneSnapshot[];
  recentAnnouncements: AnnouncementSnapshot[];
  upcomingCelebrations: CelebrationSnapshot[];
  generatedAt: string;
};

export function buildGrandparentDigest(input: {
  familyName: string;
  members: MemberSnapshot[];
  photos: PhotoSnapshot[];
  milestones: MilestoneSnapshot[];
  announcements: AnnouncementSnapshot[];
  celebrations: CelebrationSnapshot[];
}): GrandparentDigest {
  return {
    familyName: input.familyName,
    members: input.members,
    recentPhotos: input.photos.slice(0, 12),
    recentMilestones: input.milestones.slice(0, 10),
    recentAnnouncements: input.announcements.slice(0, 8),
    upcomingCelebrations: input.celebrations
      .filter((c) => c.daysUntil >= 0 && c.daysUntil <= 90)
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .slice(0, 10),
    generatedAt: new Date().toISOString(),
  };
}

export function digestSummary(d: GrandparentDigest): string {
  const parts: string[] = [];
  parts.push(`${d.members.length} family member${d.members.length === 1 ? '' : 's'}`);
  if (d.recentPhotos.length > 0) parts.push(`${d.recentPhotos.length} recent photo${d.recentPhotos.length === 1 ? '' : 's'}`);
  if (d.recentMilestones.length > 0) parts.push(`${d.recentMilestones.length} milestone${d.recentMilestones.length === 1 ? '' : 's'}`);
  if (d.upcomingCelebrations.length > 0) parts.push(`${d.upcomingCelebrations.length} upcoming celebration${d.upcomingCelebrations.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function celebrationCountdown(days: number): string {
  if (days === 0) return 'Today!';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

// ── Cross-household (M28) ───────────────────────────────────────────────────
// A grandparent invited into two of their children's families is a member of
// both, with a role in each (lib/supabase/auth builds `ctx.memberships` from
// every family_members row). The portal used to show the ACTIVE family only, so
// staying in touch with the other grandchildren meant switching households in
// the sidebar. These helpers keep the ordering decision pure and testable; the
// per-family reads stay in the page, where the fail-closed guard lives.

export type HouseholdRef = {
  familyId: string;
  familyName: string;
};

/**
 * The households to render, active family first and the rest alphabetically.
 *
 * Active-first because that is the family the rest of the app is currently
 * showing — a portal that reorders itself around a switch nobody made is
 * disorienting. Duplicate memberships (the same family twice) collapse to one.
 */
export function orderHouseholds(households: HouseholdRef[], activeFamilyId: string): HouseholdRef[] {
  const seen = new Set<string>();
  const unique = households.filter((h) => (seen.has(h.familyId) ? false : (seen.add(h.familyId), true)));
  return unique.sort((a, b) => {
    if (a.familyId === activeFamilyId) return -1;
    if (b.familyId === activeFamilyId) return 1;
    return a.familyName.localeCompare(b.familyName);
  });
}
