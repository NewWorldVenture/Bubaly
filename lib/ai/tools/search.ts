// One read tool that looks across the whole household.
//
// Before this, the assistant could list documents, list open chores, list
// upcoming events — a dozen narrow reads, each of which needs the model to
// have guessed which module a thing lives in. "Where is the furnace warranty?"
// is not a documents question or a home question until you already know the
// answer, so the model either guessed or asked. `search.household` is the tool
// for the case where the module is the thing being looked for.
//
// WHY THE TRUST DOMAIN IS `tasks`: `TRUST_DOMAINS` has no cross-cutting search
// domain, and `documents`/`finances` are in `HIGH_STAKES_AI_DOMAINS`, which
// would put an approval in front of a READ — a person asking "where's the
// warranty?" should not have to approve looking. `lib/ai/tools/memory.ts` made
// the same call for the same reason. The real boundary is not the dial anyway:
// `lib/services/search` decides per role which sources are searched at all, so
// a child's assistant cannot reach bills, warranties, renewals or a sensitive
// document through this tool whatever the dial says.
//
// Every string that comes back is household text a person (or an inbound
// email) wrote, so it goes through `sanitizeUntrusted` before it reaches a
// prompt — §41's rule that data never arrives as instructions.
import 'server-only';
import { z } from 'zod';
import { sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { searchHousehold, DEFAULT_LIMIT, MAX_LIMIT } from '@/lib/services/search';
import { SEARCH_KINDS } from '@/lib/search/rank';
import { ok } from '@/lib/services/types';
import { defineTool, plural, type ToolDefinition } from './types';

/** Titles and snippets are trimmed hard: this is a locator, not a document reader. */
const MAX_TITLE_CHARS = 160;
const MAX_SNIPPET_CHARS = 200;

const hit = z.object({
  kind: z.enum(SEARCH_KINDS),
  id: z.string(),
  title: z.string(),
  snippet: z.string().nullable(),
  /** The evidence: which table this came from. */
  table: z.string(),
  /** The date the record is about, ISO; null when it has none. */
  occurred_at: z.string().nullable(),
  /** An in-app route that already shows this record. */
  href: z.string(),
});

export const searchTools: ToolDefinition[] = [
  defineTool({
    name: 'search.household',
    aliases: ['search_household', 'household_search', 'find_in_household'],
    description: 'Search everything the household has recorded — documents, inventory items, trips, vacations, bills, warranties, renewals, decisions, calendar events, notes and remembered facts — and get back records with the table they came from, their date and a link. Read-only. Bills, warranties and renewals are searched only for parents and adults.',
    domain: 'tasks',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      query: z.string().describe('What to look for, e.g. "furnace warranty", "Emma passport", "Lisbon"'),
      limit: z.number().int().nullish().describe(`How many records to return; defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}`),
    }),
    output: z.object({
      query: z.string(),
      hits: z.array(hit),
      /** Sources that could not be searched. Non-empty means this answer is incomplete. */
      unavailable: z.array(z.string()),
      /** Sources this member is not allowed to search. */
      withheld: z.array(z.string()),
    }),
    summarize: (_input, output) => {
      // Never "nothing exists" when a source was unreadable or off-limits: the
      // honest sentence names what was not looked at.
      const caveats: string[] = [];
      if (output.unavailable.length > 0) caveats.push(`could not search ${output.unavailable.join(', ')}`);
      if (output.withheld.length > 0) caveats.push(`${output.withheld.join(', ')} are not visible to this member`);
      const tail = caveats.length > 0 ? ` (${caveats.join('; ')})` : '';
      if (output.hits.length === 0) return `Nothing in the household matched “${output.query}”${tail}`;
      const first = output.hits[0];
      return `Found ${plural(output.hits.length, 'record')} for “${output.query}”, starting with ${first.title} in ${first.table}${tail}`;
    },
    execute: async (scope, input) => {
      const res = await searchHousehold(scope, input.query, input.limit ?? DEFAULT_LIMIT);
      if (!res.ok) return res;
      return ok({
        query: sanitizeUntrusted(res.data.query, MAX_TITLE_CHARS),
        hits: res.data.hits.map((row) => ({
          kind: row.kind,
          id: row.id,
          title: sanitizeUntrusted(row.title, MAX_TITLE_CHARS),
          snippet: row.snippet ? sanitizeUntrusted(row.snippet, MAX_SNIPPET_CHARS) : null,
          table: row.table,
          occurred_at: row.occurredAt,
          href: row.href,
        })),
        unavailable: res.data.partial.map((failure) => failure.table),
        withheld: [...res.data.withheld],
      });
    },
  }),
];
