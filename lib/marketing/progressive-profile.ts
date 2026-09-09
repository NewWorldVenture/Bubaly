// lib/marketing/progressive-profile.ts — the progressive-profiling brain (pure,
// unit-tested). Progressive profiling asks ONE question at a time across visits
// instead of a wall of fields: given what's already known (and what the person
// skipped), it picks the next thing to ask and tracks completeness. No browser
// or DB deps.

export type ProfileField = 'role' | 'top_priority' | 'household_size' | 'child_ages' | 'interests';

export type ProfileQuestion = {
  field: ProfileField;
  kind: 'choice' | 'multi';
  /** Catalogue keys, not copy. `value` is the stored identifier and stays
   *  English; everything a person reads goes through the catalogue, which is
   *  what the public profile nudge renders. */
  promptKey: string;
  helpKey?: string;
  options: { value: string; labelKey: string }[];
};

// Ordered — earlier questions are the highest-signal for tailoring the product.
export const PROFILE_QUESTIONS: ProfileQuestion[] = [
  {
    field: 'role', kind: 'choice',
    promptKey: 'profileQuestions.rolePrompt',
    options: [
      { value: 'parent', labelKey: 'profileQuestions.roleParent' },
      { value: 'grandparent', labelKey: 'profileQuestions.roleGrandparent' },
      { value: 'caregiver', labelKey: 'profileQuestions.roleCaregiver' },
      { value: 'other', labelKey: 'profileQuestions.roleOther' },
    ],
  },
  {
    field: 'top_priority', kind: 'choice',
    promptKey: 'profileQuestions.priorityPrompt',
    options: [
      { value: 'calendar', labelKey: 'profileQuestions.priorityCalendar' },
      { value: 'meals', labelKey: 'profileQuestions.priorityMeals' },
      { value: 'chores', labelKey: 'profileQuestions.priorityChores' },
      { value: 'money', labelKey: 'profileQuestions.priorityMoney' },
      { value: 'paperwork', labelKey: 'profileQuestions.priorityPaperwork' },
      { value: 'other', labelKey: 'profileQuestions.priorityOther' },
    ],
  },
  {
    field: 'household_size', kind: 'choice',
    promptKey: 'profileQuestions.householdPrompt',
    options: [
      { value: '2', labelKey: 'profileQuestions.householdTwo' },
      { value: '3', labelKey: 'profileQuestions.householdThree' },
      { value: '4', labelKey: 'profileQuestions.householdFour' },
      { value: '5', labelKey: 'profileQuestions.householdFive' },
      { value: '6', labelKey: 'profileQuestions.householdSixPlus' },
    ],
  },
  {
    field: 'child_ages', kind: 'choice',
    promptKey: 'profileQuestions.childAgesPrompt',
    helpKey: 'profileQuestions.childAgesHelp',
    options: [
      { value: 'none', labelKey: 'profileQuestions.childAgesNone' },
      { value: 'little', labelKey: 'profileQuestions.childAgesLittle' },
      { value: 'school', labelKey: 'profileQuestions.childAgesSchool' },
      { value: 'teen', labelKey: 'profileQuestions.childAgesTeen' },
      { value: 'mixed', labelKey: 'profileQuestions.childAgesMixed' },
    ],
  },
  {
    field: 'interests', kind: 'multi',
    promptKey: 'profileQuestions.interestsPrompt',
    helpKey: 'profileQuestions.interestsHelp',
    options: [
      { value: 'calendar', labelKey: 'profileQuestions.interestCalendar' },
      { value: 'meals', labelKey: 'profileQuestions.interestMeals' },
      { value: 'chores', labelKey: 'profileQuestions.interestChores' },
      { value: 'money', labelKey: 'profileQuestions.interestMoney' },
      { value: 'paperwork', labelKey: 'profileQuestions.interestPaperwork' },
      { value: 'health', labelKey: 'profileQuestions.interestHealth' },
      { value: 'activities', labelKey: 'profileQuestions.interestActivities' },
    ],
  },
];

export type KnownProfile = Partial<Record<ProfileField, string | number | string[] | null>>;

/** A field counts as answered when it has a real value (non-empty). */
export function isAnswered(value: KnownProfile[ProfileField]): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true; // number
}

/** The next question to ask: first field that's neither answered nor skipped. */
export function nextQuestion(known: KnownProfile, skipped: string[] = []): ProfileQuestion | null {
  const skip = new Set(skipped);
  for (const q of PROFILE_QUESTIONS) {
    if (skip.has(q.field)) continue;
    if (!isAnswered(known[q.field])) return q;
  }
  return null;
}

/** 0..1 share of profile questions answered (skips don't count as answered). */
export function profileCompleteness(known: KnownProfile): number {
  const answered = PROFILE_QUESTIONS.filter((q) => isAnswered(known[q.field])).length;
  return Math.round((answered / PROFILE_QUESTIONS.length) * 100) / 100;
}

/** Validate/normalize an answer for a field; returns null if invalid. */
export function normalizeAnswer(field: ProfileField, raw: unknown): string | number | string[] | null {
  const q = PROFILE_QUESTIONS.find((x) => x.field === field);
  if (!q) return null;
  const allowed = new Set(q.options.map((o) => o.value));

  if (q.kind === 'multi') {
    const arr = Array.isArray(raw) ? raw : [];
    const clean = [...new Set(arr.map(String).filter((v) => allowed.has(v)))];
    return clean.length ? clean : null;
  }
  const v = String(raw);
  if (!allowed.has(v)) return null;
  if (field === 'household_size') { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  return v;
}
