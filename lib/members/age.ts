// lib/members/age.ts — shared "how old is this member today" helper.

/** Whole years old on `today` for a YYYY-MM-DD birthday (null when unknown/invalid). */
export function ageOn(birthday: string | null | undefined, today: Date): number | null {
  if (!birthday) return null;
  const b = new Date(`${birthday.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  let age = today.getFullYear() - b.getFullYear();
  const beforeBirthday = today.getMonth() < b.getMonth() || (today.getMonth() === b.getMonth() && today.getDate() < b.getDate());
  if (beforeBirthday) age -= 1;
  return Math.max(0, age);
}
