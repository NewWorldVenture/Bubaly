/**
 * The row the contacts form writes, built from what was typed.
 *
 * Every optional text field becomes null when left blank — except
 * `relationship`, which the table declares NOT NULL (default 'other', 0014).
 * An explicit null does not fall back to that default: Postgres rejects the
 * insert, and the form answered "Some required information is missing or
 * invalid" for a contact whose only omission was a field it never marked as
 * required (UIF-001). A blank relationship is written as an empty string, which
 * every reader already treats as "none given".
 */
export type ContactForm = { get(key: string): FormDataEntryValue | null };

export function contactPayload(form: ContactForm) {
  const g = (key: string) => String(form.get(key) ?? '').trim() || null;
  const day = form.get('birthday_day');
  const month = form.get('birthday_month');
  return {
    name: g('name') ?? '',
    relationship: g('relationship') ?? '',
    category: String(form.get('category') ?? 'other'),
    phone: g('phone'),
    phone_alt: g('phone_alt'),
    email: g('email'),
    address: g('address'),
    specialty: g('specialty'),
    organization: g('organization'),
    notes: g('notes'),
    is_emergency: form.get('is_emergency') === 'on',
    birthday_month: month ? Number(month) : null,
    birthday_day: day ? Number(day) : null,
  };
}
