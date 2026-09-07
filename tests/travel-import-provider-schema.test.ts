import { describe, expect, it } from 'vitest';
import { travelImportTools } from '@/lib/ai/tools/travel-import';
import { toToolSpecs, toolInputSchema } from '@/lib/ai/tools/legacy-adapter';
import {
  confirmationSourceSchema, confirmationFieldsSchema,
} from '@/lib/vacations/confirmation-import';
import type { ServiceScope } from '@/lib/services/types';

const tool = travelImportTools[0];
const input = {
  vacationId: '11111111-1111-4111-8111-111111111111',
  source: { title: 'Dinner confirmation', text: 'Name: Dinner\nGuests: 2' },
  fields: {
    name: 'Dinner',
    kind: 'restaurant',
    location: null,
    reservedAt: '2026-09-06T18:30:00-04:00',
    partySize: null,
    confirmationCode: null,
    booked: false,
  },
};

function strictProperties(schema: unknown, keys: string[]): Record<string, unknown> {
  expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
  const object = schema as { properties: Record<string, unknown>; required: string[] };
  expect(Object.keys(object.properties).sort()).toEqual([...keys].sort());
  expect([...object.required].sort()).toEqual([...keys].sort());
  return object.properties;
}

describe('travel.import provider input', () => {
  it('exports strict JSON Schema with every nested field required', () => {
    const properties = strictProperties(toolInputSchema(tool), ['vacationId', 'source', 'fields']);
    strictProperties(properties.source, ['title', 'text']);
    strictProperties(properties.fields, [
      'name', 'kind', 'location', 'reservedAt', 'partySize', 'confirmationCode', 'booked',
    ]);
  });

  it('includes travel.import in the provider adapter', () => {
    const scope = { familyId: 'fam-1', db: {} } as unknown as ServiceScope;
    expect(toToolSpecs(scope, { names: ['travel.import'] }).map((spec) => spec.name))
      .toEqual(['travel_import']);
  });

  it.each([false, true])('preserves explicit booked=%s and nullable fields', (booked) => {
    const candidate = { ...input, fields: { ...input.fields, booked } };
    expect(tool.input.parse(candidate)).toEqual(candidate);
    expect(confirmationSourceSchema.safeParse(candidate.source).success).toBe(true);
    expect(confirmationFieldsSchema.safeParse(candidate.fields).success).toBe(true);
  });

  it('preserves complete non-null fields and source text without normalization', () => {
    const candidate = {
      ...input,
      source: { ...input.source, text: '  Name: Dinner\r\nGuests: 2\n' },
      fields: { ...input.fields, location: 'Restaurant', partySize: 2, confirmationCode: 'ABC123' },
    };
    expect(tool.input.parse(candidate)).toEqual(candidate);
    expect(confirmationSourceSchema.safeParse(candidate.source).success).toBe(true);
    expect(confirmationFieldsSchema.safeParse(candidate.fields).success).toBe(true);
  });

  it.each(['name', 'kind', 'location', 'reservedAt', 'partySize', 'confirmationCode', 'booked'])
    ('requires fields.%s even when its value may be null', (key) => {
      const fields = Object.fromEntries(Object.entries(input.fields).filter(([name]) => name !== key));
      expect(tool.input.safeParse({ ...input, fields }).success).toBe(false);
    });

  it.each([
    ['extra top-level key', { ...input, save: true }],
    ['extra source key', { ...input, source: { ...input.source, url: 'https://example.com' } }],
    ['extra fields key', { ...input, fields: { ...input.fields, providerVerified: true } }],
    ['invalid trip ID', { ...input, vacationId: 'not-a-uuid' }],
    ['empty title', { ...input, source: { ...input.source, title: '' } }],
    ['long title', { ...input, source: { ...input.source, title: 'a'.repeat(161) } }],
    ['empty source', { ...input, source: { ...input.source, text: '' } }],
    ['long source', { ...input, source: { ...input.source, text: 'a'.repeat(65537) } }],
    ['long name', { ...input, fields: { ...input.fields, name: 'a'.repeat(201) } }],
    ['long kind', { ...input, fields: { ...input.fields, kind: 'a'.repeat(41) } }],
    ['long location', { ...input, fields: { ...input.fields, location: 'a'.repeat(501) } }],
    ['long code', { ...input, fields: { ...input.fields, confirmationCode: 'a'.repeat(121) } }],
    ['zero party size', { ...input, fields: { ...input.fields, partySize: 0 } }],
    ['large party size', { ...input, fields: { ...input.fields, partySize: 1001 } }],
    ['fractional party size', { ...input, fields: { ...input.fields, partySize: 1.5 } }],
    ['string party size', { ...input, fields: { ...input.fields, partySize: '2' } }],
    ['string booked', { ...input, fields: { ...input.fields, booked: 'false' } }],
    ['null booked', { ...input, fields: { ...input.fields, booked: null } }],
  ])('rejects structural violations: %s', (_label, candidate) => {
    expect(tool.input.safeParse(candidate).success).toBe(false);
  });
});

describe('travel.import domain refinements remain strict', () => {
  it.each([
    ['title whitespace', { ...input.source, title: ' Dinner confirmation ' }],
    ['invalid title Unicode', { ...input.source, title: '\ud800' }],
    ['blank source', { ...input.source, text: ' \n\t' }],
    ['invalid source Unicode', { ...input.source, text: '\ud800' }],
    ['source character limit', { ...input.source, text: 'a'.repeat(32769) }],
    ['source UTF-8 byte limit', { ...input.source, text: '\u20ac'.repeat(21846) }],
  ])('keeps %s validation in the domain schema', (_label, source) => {
    expect(tool.input.safeParse({ ...input, source }).success).toBe(true);
    expect(confirmationSourceSchema.safeParse(source).success).toBe(false);
  });

  it.each([
    ['name whitespace', { ...input.fields, name: ' Dinner ' }],
    ['kind whitespace', { ...input.fields, kind: ' restaurant ' }],
    ['location whitespace', { ...input.fields, location: ' Restaurant ' }],
    ['code whitespace', { ...input.fields, confirmationCode: ' ABC123 ' }],
    ['invalid field Unicode', { ...input.fields, name: '\ud800' }],
    ['impossible date', { ...input.fields, reservedAt: '2026-02-30T18:30:00Z' }],
    ['missing timezone', { ...input.fields, reservedAt: '2026-09-06T18:30:00' }],
    ['missing seconds', { ...input.fields, reservedAt: '2026-09-06T18:30Z' }],
    ['excess timestamp precision', { ...input.fields, reservedAt: '2026-09-06T18:30:00.1234Z' }],
    ['invalid offset', { ...input.fields, reservedAt: '2026-09-06T18:30:00+14:01' }],
  ])('keeps %s validation in the domain schema', (_label, fields) => {
    expect(tool.input.safeParse({ ...input, fields }).success).toBe(true);
    expect(confirmationFieldsSchema.safeParse(fields).success).toBe(false);
  });
});
