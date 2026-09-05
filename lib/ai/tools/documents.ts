// Document tools. `documents` is a HIGH_STAKES_AI_DOMAIN, so every read here
// is evaluated as `view` by the executor and the view-sensitivity rule keeps
// a child's or guest's assistant out. Listings return titles and metadata
// only; the file itself is reached through `documents.readDocument`, which
// hands back a two-minute signed URL and refuses sensitive documents to
// anyone but a parent or adult — the service enforces that, the tool merely
// reports it.
import 'server-only';
import { z } from 'zod';
import { expiringBefore, linkToVacation, listDocuments, readDocument, todayKey } from '@/lib/services/documents';
import { ok } from '@/lib/services/types';
import { resolveAssigneeId } from './family';
import { defineTool, plural, type ToolDefinition } from './types';

const DOC_KINDS = ['passport', 'id', 'visa', 'ticket', 'boarding_pass', 'hotel_confirmation', 'rental_confirmation', 'insurance', 'itinerary', 'medical', 'other'] as const;

const meta = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  mime_type: z.string().nullable(),
  expires_at: z.string().nullable(),
  member_id: z.string().nullable(),
  sensitive: z.boolean(),
});

const toMeta = (d: { id: string; title: string; category: string | null; mimeType: string | null; expiresAt: string | null; memberId: string | null; sensitive: boolean }) => ({
  id: d.id, title: d.title, category: d.category, mime_type: d.mimeType, expires_at: d.expiresAt, member_id: d.memberId, sensitive: d.sensitive,
});

function addDays(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const documentTools: ToolDefinition[] = [
  defineTool({
    name: 'documents.listDocuments',
    aliases: ['list_documents', 'search_documents'],
    description: 'List stored documents by title and metadata (never contents). Filter by category, family member or a word in the title.',
    domain: 'documents',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      category: z.string().nullish(),
      member: z.string().nullish().describe('Family member name'),
      member_id: z.string().nullish(),
      query: z.string().nullish().describe('Word to match in the title'),
      limit: z.number().int().nullish(),
    }),
    output: z.object({ documents: z.array(meta) }),
    summarize: (_input, output) => (output.documents.length === 0
      ? 'No matching documents'
      : `Found ${plural(output.documents.length, 'document')}, starting with ${output.documents[0].title}`),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await listDocuments(scope, { category: input.category ?? null, memberId: member.data, query: input.query ?? null, limit: input.limit ?? undefined });
      if (!res.ok) return res;
      return ok({ documents: res.data.map(toMeta) });
    },
  }),

  defineTool({
    name: 'documents.expiringBefore',
    aliases: ['expiring_documents', 'documents_expiring'],
    description: 'Documents that expire on or before a date (or within a number of days), soonest first. Already-expired ones are included.',
    domain: 'documents',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      date: z.string().nullish().describe('YYYY-MM-DD'),
      within_days: z.number().int().nullish().describe('Alternative to date; defaults to 60 when neither is given'),
      member: z.string().nullish(),
      member_id: z.string().nullish(),
    }),
    output: z.object({ before: z.string(), documents: z.array(meta) }),
    summarize: (_input, output) => (output.documents.length === 0
      ? `Nothing expires before ${output.before}`
      : `${plural(output.documents.length, 'document')} expiring by ${output.before}; first is ${output.documents[0].title} (${output.documents[0].expires_at})`),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const before = input.date ?? addDays(todayKey(scope), input.within_days ?? 60);
      const res = await expiringBefore(scope, before, { memberId: member.data });
      if (!res.ok) return res;
      return ok({ before, documents: res.data.map(toMeta) });
    },
  }),

  defineTool({
    name: 'documents.readDocument',
    aliases: ['read_document', 'open_document'],
    description: 'Get a short-lived link to open one document. Sensitive documents (secure vault, legal, medical, financial, identity) are only available to parents and adults.',
    domain: 'documents',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ document_id: z.string() }),
    output: z.object({ document: meta, url: z.string(), expires_at: z.string() }),
    summarize: (_input, output) => `Opened "${output.document.title}" (link valid until ${output.expires_at})`,
    execute: async (scope, input) => {
      const res = await readDocument(scope, input.document_id);
      if (!res.ok) return res;
      return ok({ document: toMeta(res.data.document), url: res.data.url, expires_at: res.data.expiresAt });
    },
  }),

  defineTool({
    name: 'documents.linkToVacation',
    aliases: ['attach_document_to_trip', 'link_document_to_vacation'],
    description: 'Attach a stored document (passport, ticket, confirmation) to a trip so the trip readiness check can see it.',
    domain: 'documents',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      document_id: z.string(),
      vacation_id: z.string(),
      kind: z.enum(DOC_KINDS).nullish().describe('Guessed from the document when omitted'),
      member: z.string().nullish().describe('Whose document it is'),
      member_id: z.string().nullish(),
      expires_on: z.string().nullish().describe('YYYY-MM-DD, e.g. passport expiry'),
    }),
    output: z.object({ link_id: z.string(), title: z.string(), kind: z.string(), vacation_id: z.string(), created: z.boolean() }),
    idempotencyFrom: (input) => `documents.linkToVacation:${input.vacation_id}:${input.document_id}`,
    summarize: (_input, output) => (output.created ? `Attached "${output.title}" to the trip as ${output.kind.replace(/_/g, ' ')}` : `"${output.title}" was already on the trip`),
    resource: (output) => ({ table: 'vacation_documents', id: output.link_id }),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await linkToVacation(scope, {
        documentId: input.document_id, vacationId: input.vacation_id, kind: input.kind ?? null, memberId: member.data, expiresOn: input.expires_on ?? null,
      });
      if (!res.ok) return res;
      return ok({ link_id: res.data.link.id, title: res.data.link.title, kind: res.data.link.kind, vacation_id: res.data.link.vacation_id, created: res.data.created });
    },
  }),
];
