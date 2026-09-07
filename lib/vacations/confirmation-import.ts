import { z } from 'zod';

const UUID = z.string().uuid();
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const MIN_INSTANT = Date.parse('0001-01-01T00:00:00Z');
const MAX_INSTANT = Date.parse('9999-12-31T23:59:59.999Z');

export function isConfirmationCalendarDate(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function isConfirmationInstant(value: string, precision = 3): boolean {
  const match = INSTANT.exec(value);
  if (!match || !isConfirmationCalendarDate(value.slice(0, 10))) return false;
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false;
  if ((match[7]?.length ?? 0) > precision) return false;
  if (match[8] !== 'Z') {
    const hours = Number(match[10]), minutes = Number(match[11]);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant >= MIN_INSTANT && instant <= MAX_INSTANT;
}

function unicodeText(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function canonicalText(max: number) {
  return z.string().min(1).max(max)
    .refine((value) => value === value.trim(), 'Remove surrounding whitespace.')
    .refine(unicodeText, 'Use valid Unicode text.');
}

const calendarDate = z.string().refine(isConfirmationCalendarDate, 'Use a real YYYY-MM-DD date.');
const recordedInstant = z.string().refine((value) => isConfirmationInstant(value, 6), 'Invalid recorded timestamp.');

export const confirmationSourceSchema = z.object({
  title: canonicalText(160),
  text: z.string().min(1).max(65536)
    .refine(unicodeText, 'Use valid Unicode source text.')
    .refine((value) => Array.from(value).length <= 32768, 'The source exceeds 32,768 characters.')
    .refine((value) => new TextEncoder().encode(value).byteLength <= 65536, 'The source exceeds 64 KiB.')
    .refine((value) => /\S/u.test(value), 'Paste a confirmation source.'),
}).strict();

export const confirmationFieldsSchema = z.object({
  name: canonicalText(200),
  kind: canonicalText(40),
  location: canonicalText(500).nullable(),
  reservedAt: z.string().refine((value) => isConfirmationInstant(value), 'Use a real timestamp with seconds and an explicit UTC offset.'),
  partySize: z.number().int().min(1).max(1000).nullable(),
  confirmationCode: canonicalText(120).nullable(),
  booked: z.boolean(),
}).strict();

export const confirmationPreviewSchema = z.object({
  version: z.literal(1),
  familyId: UUID,
  vacationId: UUID,
  memberId: UUID,
  trip: z.object({
    id: UUID,
    title: z.string().min(1),
    startDate: calendarDate,
    endDate: calendarDate,
    timezone: canonicalText(128),
    status: z.enum(['planning', 'booked', 'active', 'completed']),
    updatedAt: recordedInstant,
  }).strict(),
  source: confirmationSourceSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  fields: confirmationFieldsSchema,
  itinerary: z.object({
    date: calendarDate,
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
    dayPart: z.enum(['morning', 'afternoon', 'evening']),
  }).strict(),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.trip.id !== value.vacationId) issue('The trip identity does not match.');
  if (value.trip.startDate > value.trip.endDate) issue('The trip date range is invalid.');
  if (value.itinerary.date < value.trip.startDate || value.itinerary.date > value.trip.endDate) issue('The reservation falls outside this trip.');
  const hour = Number(value.itinerary.startTime.slice(0, 2));
  if (value.itinerary.dayPart !== (hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening')) issue('The itinerary day part does not match its time.');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: value.trip.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(value.fields.reservedAt));
    const part = (name: string) => parts.find((entry) => entry.type === name)?.value ?? '';
    const date = part('year').padStart(4, '0') + '-' + part('month') + '-' + part('day');
    const time = part('hour') + ':' + part('minute') + ':' + part('second');
    if (value.itinerary.date !== date || value.itinerary.startTime !== time) issue('The itinerary does not match the recorded trip timezone.');
  } catch {
    issue('The recorded trip timezone or reservation time is unavailable.');
  }
});

export const confirmationResultSchema = z.discriminatedUnion('applied', [
  z.object({
    preview: confirmationPreviewSchema, applied: z.literal(false),
    requestId: z.null(), appliedAt: z.null(), reservationId: z.null(), itineraryItemId: z.null(),
  }).strict(),
  z.object({
    preview: confirmationPreviewSchema, applied: z.literal(true),
    requestId: UUID, appliedAt: recordedInstant, reservationId: UUID, itineraryItemId: UUID,
  }).strict(),
]);

export type ConfirmationSource = z.infer<typeof confirmationSourceSchema>;
export type ConfirmationFields = z.infer<typeof confirmationFieldsSchema>;
export type ConfirmationPreview = z.infer<typeof confirmationPreviewSchema>;
export type ConfirmationResult = z.infer<typeof confirmationResultSchema>;

export type ConfirmationImportContext = {
  familyId: string | null;
  userId: string | null;
  memberId: string | null;
  role: string | null;
  active: boolean;
  vacationId: string;
};

export function confirmationContextKey(context: ConfirmationImportContext): string {
  return JSON.stringify([context.familyId, context.userId, context.memberId, context.role, context.active, context.vacationId]);
}

export function canImportConfirmation(context: ConfirmationImportContext): boolean {
  return context.active && (context.role === 'parent' || context.role === 'adult')
    && [context.familyId, context.userId, context.memberId, context.vacationId].every((value) => UUID.safeParse(value).success);
}

/** JSON object order is not meaningful; source string bytes are never normalised. */
export function sameConfirmationValue(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
    }
    return value;
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export type ConfirmationSuggestions = {
  fields: Partial<ConfirmationFields>;
  evidence: { field: keyof ConfirmationFields; line: number; text: string }[];
  warnings: string[];
};

const LABELS: Record<string, keyof ConfirmationFields> = {
  name: 'name', 'reservation name': 'name', reservation: 'name', 'booking name': 'name',
  kind: 'kind', type: 'kind', 'reservation type': 'kind',
  location: 'location', address: 'location',
  'reserved at': 'reservedAt', 'reservation time': 'reservedAt', 'date and time': 'reservedAt', when: 'reservedAt',
  'party size': 'partySize', guests: 'partySize',
  'confirmation code': 'confirmationCode', 'confirmation number': 'confirmationCode',
  'booking reference': 'confirmationCode', reference: 'confirmationCode',
};

/** A deterministic label reader, not a provider or an instruction interpreter. */
export function suggestConfirmationFields(text: string): ConfirmationSuggestions {
  const output: ConfirmationSuggestions = { fields: {}, evidence: [], warnings: [] };
  if (!confirmationSourceSchema.shape.text.safeParse(text).success) {
    output.warnings.push('The source is invalid or too large for suggestions.');
    return output;
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 500) {
    output.warnings.push('This source has more than 500 lines. Enter fields manually after reviewing the complete source.');
    return output;
  }
  const candidates = new Map<keyof ConfirmationFields, { value: string; line: number; text: string }[]>();
  lines.forEach((line, index) => {
    const match = /^\s*([A-Za-z][A-Za-z _-]{0,40})\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) return;
    const label = match[1].trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    const field = LABELS[label];
    if (!field) return;
    const entries = candidates.get(field) ?? [];
    entries.push({ value: match[2].trim(), line: index + 1, text: line });
    candidates.set(field, entries);
  });
  for (const [field, candidatesForField] of candidates) {
    if (candidatesForField.length !== 1) {
      output.warnings.push('Multiple source lines describe ' + field + '; enter that field manually.');
      continue;
    }
    const candidate = candidatesForField[0];
    const value = field === 'partySize' && /^\d+$/.test(candidate.value) ? Number(candidate.value) : candidate.value;
    const parsed = confirmationFieldsSchema.shape[field].safeParse(value);
    if (!parsed.success) {
      output.warnings.push('The source value for ' + field + ' needs manual correction.');
      continue;
    }
    Object.assign(output.fields, { [field]: parsed.data });
    output.evidence.push({ field, line: candidate.line, text: candidate.text });
  }
  return output;
}

