// The service-provider half of "find me a plumber": read-only.
//
// There is no `services.requestQuotes` and no `services.book` here, on purpose.
// Bubaly has no provider directory, solicits no quotes and places no calls, so
// the only honest tool in this domain today is the one that ranks the quotes a
// parent already typed into a project — and says why, in words the family
// sees on the same screen (`lib/services/providers/compare.ts`).
import 'server-only';
import { z } from 'zod';
import { findHomeProject, listProjectQuotes, listProjectsWithQuotes } from '@/lib/services/home';
import { compareQuotes } from '@/lib/services/providers/compare';
import { scopeNow } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { defineTool, plural, type ToolDefinition } from './types';

const rankedQuote = z.object({
  rank: z.number().int(),
  quote_id: z.string(),
  contractor_name: z.string(),
  amount_cents: z.number().int(),
  includes_materials: z.boolean(),
  lead_time_days: z.number().int().nullable(),
  valid_until: z.string().nullable(),
  status: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
  tied_with: z.array(z.string()),
});

export const providerTools: ToolDefinition[] = [
  defineTool({
    name: 'services.compareQuotes',
    aliases: ['compare_quotes', 'compare_project_quotes'],
    description: 'Rank the contractor quotes the family has on file for a home project — by price, how soon they can start, what is included and whether scope or warranty notes exist — with the reasons for each rank and any tie explained. Reads only what a parent recorded; never solicits a quote or names a provider that is not on file.',
    domain: 'home_maintenance',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      project_id: z.string().nullish().describe('The home project id, when known'),
      project: z.string().nullish().describe('Otherwise the project title, or part of it'),
    }),
    output: z.object({
      project: z.object({ id: z.string(), title: z.string(), status: z.string() }).nullable(),
      ranked: z.array(rankedQuote),
      excluded: z.array(z.object({ quote_id: z.string(), contractor_name: z.string(), reason: z.string() })),
      ties: z.array(z.string()),
      summary: z.string(),
      /** When no project was named and several have quotes: what to ask about. */
      candidates: z.array(z.object({ id: z.string(), title: z.string(), quote_count: z.number().int() })),
    }),
    summarize: (_input, output) => {
      if (!output.project) {
        return output.candidates.length === 0
          ? 'No project quotes on file yet'
          : `${plural(output.candidates.length, 'project has quotes', 'projects have quotes')} — say which one to compare`;
      }
      if (output.ranked.length === 0) return `No live quotes to compare on ${output.project.title} yet`;
      return `${output.project.title}: ${output.summary}`;
    },
    execute: async (scope, input) => {
      const today = scopeNow(scope);
      let project: { id: string; title: string; status: string } | null = null;

      if (input.project_id || input.project) {
        const found = await findHomeProject(scope, { id: input.project_id ?? null, title: input.project ?? null });
        if (!found.ok) return found;
        if (!found.data) return fail(`No project matches "${input.project_id ?? input.project}".`, { code: SERVICE_CODES.notFound });
        project = { id: found.data.id, title: found.data.title, status: found.data.status };
      } else {
        const withQuotes = await listProjectsWithQuotes(scope);
        if (!withQuotes.ok) return withQuotes;
        if (withQuotes.data.length === 1) {
          project = withQuotes.data[0].project;
        } else {
          return ok({
            project: null, ranked: [], excluded: [], ties: [], summary: withQuotes.data.length === 0 ? 'No quotes on file.' : 'Several projects have quotes; name one.',
            candidates: withQuotes.data.map((c) => ({ id: c.project.id, title: c.project.title, quote_count: c.quoteCount })),
          });
        }
      }

      const quotes = await listProjectQuotes(scope, { projectId: project.id });
      if (!quotes.ok) return quotes;
      const comparison = compareQuotes(quotes.data, { today });
      return ok({
        project,
        ranked: comparison.ranked.map((r) => ({
          rank: r.rank, quote_id: r.quote.id, contractor_name: r.quote.contractor_name, amount_cents: r.quote.amount_cents,
          includes_materials: r.quote.includes_materials, lead_time_days: r.quote.lead_time_days, valid_until: r.quote.valid_until,
          status: r.quote.status, score: r.score, reasons: r.reasons.map((x) => x.text), tied_with: r.tiedWith,
        })),
        excluded: comparison.excluded.map((e) => ({ quote_id: e.quote.id, contractor_name: e.quote.contractor_name, reason: e.reason.text })),
        ties: comparison.ties.map((t) => t.text),
        summary: comparison.summary,
        candidates: [],
      });
    },
  }),
];
