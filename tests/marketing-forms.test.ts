import { describe, expect, it } from 'vitest';
import {
  inferFieldType,
  fieldKey,
  parseFormFields,
  validateSubmission,
  submissionEmail,
  submissionName,
  type FormField,
} from '@/lib/marketing/forms';

describe('inferFieldType', () => {
  it('detects email/phone/long-text from the label', () => {
    expect(inferFieldType('Email address')).toBe('email');
    expect(inferFieldType('e-mail')).toBe('email');
    expect(inferFieldType('Phone number')).toBe('tel');
    expect(inferFieldType('Your message')).toBe('textarea');
    expect(inferFieldType('First name')).toBe('text');
  });
});

describe('fieldKey', () => {
  it('snake_cases and trims', () => {
    expect(fieldKey('First Name')).toBe('first_name');
    expect(fieldKey('  E-mail!! ')).toBe('e_mail');
  });
});

describe('parseFormFields', () => {
  it('normalises legacy label/key entries and infers types', () => {
    expect(parseFormFields([{ label: 'Email', key: 'email' }, { label: 'Your message' }])).toEqual([
      { label: 'Email', key: 'email', type: 'email', required: false },
      { label: 'Your message', key: 'your_message', type: 'textarea', required: false },
    ]);
  });
  it('honours explicit type/required and de-dupes keys, dropping junk', () => {
    expect(parseFormFields([
      { label: 'Name', key: 'name', type: 'text', required: true },
      { label: 'Name again', key: 'name' }, // duplicate key dropped
      { label: '' }, // no label dropped
      null,
      'nope',
    ])).toEqual([{ label: 'Name', key: 'name', type: 'text', required: true }]);
  });
  it('returns [] for non-arrays', () => {
    expect(parseFormFields(null)).toEqual([]);
    expect(parseFormFields({})).toEqual([]);
  });
});

const fields: FormField[] = [
  { label: 'Name', key: 'name', type: 'text', required: true },
  { label: 'Email', key: 'email', type: 'email', required: true },
  { label: 'Notes', key: 'notes', type: 'textarea', required: false },
];

describe('validateSubmission', () => {
  it('passes valid input and trims/drops empty optionals', () => {
    const r = validateSubmission(fields, { name: '  Jo ', email: 'JO@x.com', notes: '' });
    expect(r.ok).toBe(true);
    expect(r.cleaned).toEqual({ name: 'Jo', email: 'JO@x.com' });
  });
  it('flags missing required fields and bad emails', () => {
    const r = validateSubmission(fields, { name: '', email: 'not-an-email' });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toMatch(/required/);
    expect(r.errors.email).toMatch(/valid email/);
  });
});

describe('submissionEmail / submissionName', () => {
  it('prefers the email-typed field, lowercased', () => {
    expect(submissionEmail(fields, { email: 'JO@X.com' })).toBe('jo@x.com');
  });
  it('falls back to any email-looking value', () => {
    const f: FormField[] = [{ label: 'Anything', key: 'anything', type: 'text', required: false }];
    expect(submissionEmail(f, { anything: 'a@b.co' })).toBe('a@b.co');
    expect(submissionEmail(f, { anything: 'plain' })).toBeNull();
  });
  it('pulls a name from a name-ish field', () => {
    expect(submissionName(fields, { name: 'Jordan' })).toBe('Jordan');
    expect(submissionName(fields, { email: 'a@b.co' })).toBeNull();
  });
});
