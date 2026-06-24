import { describe, expect, it } from 'vitest';
import {
  analyzeContacts,
  buildContactsPrompt,
  parseContactsResponse,
  type ContactLike,
} from '@/lib/contacts/ai';

function contact(overrides: Partial<ContactLike>): ContactLike {
  return { name: 'John', category: 'other', is_emergency: false, phone: null, email: null, ...overrides };
}

describe('analyzeContacts', () => {
  it('detects missing emergency contact', () => {
    const r = analyzeContacts([contact({ category: 'friend' })]);
    expect(r.emergencyReady).toBe(false);
    expect(r.summary).toContain('no emergency contact');
  });

  it('detects emergency readiness', () => {
    const r = analyzeContacts([contact({ category: 'emergency', is_emergency: true, phone: '555-1234' })]);
    expect(r.emergencyReady).toBe(true);
  });

  it('finds missing essential categories', () => {
    const r = analyzeContacts([contact({ category: 'emergency', is_emergency: true, phone: '555' })]);
    expect(r.missingCategories).toContain('doctor');
    expect(r.missingCategories).toContain('dentist');
  });

  it('detects duplicates', () => {
    const r = analyzeContacts([
      contact({ name: 'Jane Doe' }),
      contact({ name: 'jane doe' }),
    ]);
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0].count).toBe(2);
  });

  it('handles empty', () => {
    const r = analyzeContacts([]);
    expect(r.summary).toContain('0 contacts');
  });
});

describe('buildContactsPrompt', () => {
  it('builds system and user prompt', () => {
    const { system, user } = buildContactsPrompt([contact({ name: 'Dr. Smith', category: 'doctor', phone: '555' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Dr. Smith');
    expect(user).toContain('doctor');
  });
});

describe('parseContactsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseContactsResponse('{"suggestions":["add pharmacy"],"missingRoles":["vet"],"organizationTip":"group by role"}');
    expect(r.suggestions).toEqual(['add pharmacy']);
    expect(r.missingRoles).toEqual(['vet']);
    expect(r.organizationTip).toBe('group by role');
  });

  it('handles malformed input', () => {
    const r = parseContactsResponse('not json');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseContactsResponse('```json\n{"suggestions":["test"],"missingRoles":[],"organizationTip":"tip"}\n```');
    expect(r.suggestions).toEqual(['test']);
  });
});
