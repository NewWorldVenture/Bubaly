// lib/marketing/forms.ts — pure helpers for public marketing forms (render + submit).
// Normalises the form's jsonb `fields` into typed inputs (inferring a sensible
// input type for legacy label/key-only fields), validates a submission, and
// extracts the lead's email/name for the submission row + the form_submitted
// automation event. No server-only imports so it's unit-testable in isolation.

export type FormFieldType = 'text' | 'email' | 'tel' | 'textarea' | 'number';

export type FormField = {
  label: string;
  key: string;
  type: FormFieldType;
  required: boolean;
};

const TYPES: readonly FormFieldType[] = ['text', 'email', 'tel', 'textarea', 'number'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Infer an input type from a field's key/label when one isn't stored. */
export function inferFieldType(labelOrKey: string): FormFieldType {
  const s = labelOrKey.toLowerCase();
  if (/e-?mail/.test(s)) return 'email';
  if (/phone|mobile|\bcell\b|\btel\b/.test(s)) return 'tel';
  if (/message|comment|note|detail|question|describe|feedback/.test(s)) return 'textarea';
  return 'text';
}

/** Sanitise a field key to lowercase snake_case (matches the admin authoring rule). */
export function fieldKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Normalise the jsonb `fields` array into typed FormFields, dropping junk and
 *  de-duplicating keys. Tolerant of legacy `{ label, key }`-only entries. */
export function parseFormFields(fields: unknown): FormField[] {
  if (!Array.isArray(fields)) return [];
  const seen = new Set<string>();
  const out: FormField[] = [];
  for (const raw of fields) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const label = typeof f.label === 'string' ? f.label.trim() : '';
    if (!label) continue;
    const key = fieldKey(typeof f.key === 'string' && f.key.trim() ? f.key : label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const type = typeof f.type === 'string' && (TYPES as readonly string[]).includes(f.type)
      ? (f.type as FormFieldType)
      : inferFieldType(`${key} ${label}`);
    out.push({ label, key, type, required: f.required === true });
  }
  return out;
}

export type SubmissionResult = {
  ok: boolean;
  errors: Record<string, string>;
  cleaned: Record<string, string>;
};

/** Validate raw submitted values against the form's fields: required fields must
 *  be present and email fields must look like emails. Returns trimmed values
 *  (empty optionals are dropped). */
export function validateSubmission(fields: FormField[], raw: Record<string, unknown>): SubmissionResult {
  const errors: Record<string, string> = {};
  const cleaned: Record<string, string> = {};
  for (const field of fields) {
    const value = typeof raw[field.key] === 'string' ? (raw[field.key] as string).trim() : '';
    if (!value) {
      if (field.required) errors[field.key] = `${field.label} is required`;
      continue;
    }
    if (field.type === 'email' && !EMAIL_RE.test(value)) {
      errors[field.key] = 'Enter a valid email address';
      continue;
    }
    cleaned[field.key] = value;
  }
  return { ok: Object.keys(errors).length === 0, errors, cleaned };
}

/** Best email value in a validated submission (first email-typed field, else the
 *  first value that looks like an email). Feeds the submission `email` column and
 *  the form_submitted automation recipient. */
export function submissionEmail(fields: FormField[], cleaned: Record<string, string>): string | null {
  for (const field of fields) {
    if (field.type === 'email' && cleaned[field.key]) return cleaned[field.key].toLowerCase();
  }
  for (const v of Object.values(cleaned)) {
    if (EMAIL_RE.test(v)) return v.toLowerCase();
  }
  return null;
}

/** Best display name in a validated submission (first field whose key mentions a
 *  name). Used as the automation event's `name` for personalised copy. */
export function submissionName(fields: FormField[], cleaned: Record<string, string>): string | null {
  for (const field of fields) {
    if (/name/.test(field.key) && cleaned[field.key]) return cleaned[field.key];
  }
  return null;
}

/** HTML autocomplete hint for a field type (helps mobile keyboards/autofill). */
export function fieldAutoComplete(type: FormFieldType): string | undefined {
  if (type === 'email') return 'email';
  if (type === 'tel') return 'tel';
  return undefined;
}

/** Map a field type to its HTML <input type> (textarea is rendered separately). */
export function inputType(type: FormFieldType): string {
  if (type === 'email') return 'email';
  if (type === 'tel') return 'tel';
  if (type === 'number') return 'number';
  return 'text';
}
