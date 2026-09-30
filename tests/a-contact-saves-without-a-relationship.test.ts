import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contactPayload } from '@/lib/contacts/payload';

// UIF-001. The contacts form marks only the name as required, but it sent a
// blank "relationship" as an explicit null, and family_contacts.relationship is
// NOT NULL. An explicit null does not take the column default: Postgres refused
// the row and the family read "Some required information is missing or
// invalid" for a contact with a name and nothing else. Found by the workflow
// audit driving the real form against a local database.
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe('a contact with only a name can be saved', () => {
  it('the table really does refuse a null relationship', () => {
    const sql = readFileSync('supabase/migrations/0014_core_platform.sql', 'utf8');
    expect(sql).toMatch(/relationship\s+text\s+not null/i);
  });

  it('writes a blank relationship as an empty string, never null', () => {
    const row = contactPayload(form({ name: 'Jane Smith', relationship: '   ' }));
    expect(row.relationship).toBe('');
    expect(contactPayload(form({ name: 'Jane Smith' })).relationship).toBe('');
  });

  it('keeps what was typed, and still nulls the optional nullable fields', () => {
    const row = contactPayload(form({ name: ' Jane ', relationship: "Emma's teacher", phone: '', birthday_day: '12' }));
    expect(row).toMatchObject({ name: 'Jane', relationship: "Emma's teacher", phone: null, email: null, birthday_day: 12, birthday_month: null, category: 'other', is_emergency: false });
  });
});
