// Home & maintenance tools — the internal half of "find me a plumber".
//
// There is deliberately NO `home.findPro` tool. Bubaly has no provider
// directory or marketplace integration; `app/api/ai/home/find-pro` produces
// hiring guidance from a model and by design never names a business. A tool
// called "find" that returned made-up plumbers would be the single worst
// thing this assistant could do to a family's trust, so the honest surface
// is: infer the trade, surface the contractor the family already used, and
// let a person choose. Saving, logging and scheduling are real writes.
import 'server-only';
import { z } from 'zod';
import {
  createMaintenanceTask, createServiceRecord, lastServiceByTrade, listContractors, listOpenMaintenance, saveContractor, tradeFromIssue,
} from '@/lib/services/home';
import { scopeNow } from '@/lib/services/scope';
import { ok } from '@/lib/services/types';
import { TRADES } from '@/lib/home/maintenance';
import { resolveAssigneeId } from './family';
import { defineTool, describeWhen, plural, type ToolDefinition } from './types';

const TRADE_VALUES = TRADES.map((t) => t.value) as [string, ...string[]];

const contractor = z.object({
  id: z.string(),
  name: z.string(),
  trade: z.string().nullable(),
  company: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  rating: z.number().nullable(),
  is_preferred: z.boolean(),
  last_used_on: z.string().nullable(),
});

export const homeTools: ToolDefinition[] = [
  defineTool({
    name: 'home.tradeFromIssue',
    aliases: ['trade_from_issue', 'which_contractor'],
    description: 'Work out which trade fixes a described problem ("the sink is leaking" → plumbing). Pure rule-based inference.',
    domain: 'home_maintenance',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ issue: z.string().describe('What is wrong, in the family\'s words') }),
    output: z.object({ trade: z.string().nullable(), label: z.string().nullable(), confidence: z.number(), matched: z.array(z.string()) }),
    summarize: (input, output) => (output.trade
      ? `"${input.issue}" sounds like a ${output.label} job`
      : `Could not tell which trade "${input.issue}" needs`),
    execute: async (_scope, input) => ok(tradeFromIssue(input.issue)),
  }),

  defineTool({
    name: 'home.listContractors',
    aliases: ['list_contractors', 'saved_contractors'],
    description: 'The contractors this family has saved, preferred and most recently used first. Filter by trade.',
    domain: 'home_maintenance',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ trade: z.string().nullish().describe(`One of ${TRADE_VALUES.join(', ')}, or a description of the job`) }),
    output: z.object({ contractors: z.array(contractor) }),
    summarize: (input, output) => (output.contractors.length === 0
      ? `No saved ${input.trade ? `${input.trade} ` : ''}contractors yet`
      : `${plural(output.contractors.length, 'saved contractor')}${input.trade ? ` for ${input.trade}` : ''}, starting with ${output.contractors[0].name}`),
    execute: async (scope, input) => {
      const res = await listContractors(scope, { trade: input.trade ?? null });
      if (!res.ok) return res;
      return ok({
        contractors: res.data.map((c) => ({
          id: c.id, name: c.name, trade: c.trade, company: c.company, phone: c.phone, email: c.email, rating: c.rating, is_preferred: c.is_preferred, last_used_on: c.last_used_on,
        })),
      });
    },
  }),

  defineTool({
    name: 'home.lastServiceByTrade',
    aliases: ['last_service_by_trade', 'who_did_we_use'],
    description: 'The most recent service visit of a trade and who did it — the first thing to check before finding someone new.',
    domain: 'home_maintenance',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ trade: z.string().describe(`One of ${TRADE_VALUES.join(', ')}, or a description of the job`) }),
    output: z.object({
      found: z.boolean(),
      record: z.object({ id: z.string(), title: z.string(), service_date: z.string(), provider: z.string().nullable(), cost: z.number().nullable() }).nullable(),
      contractor: contractor.nullable(),
      matched_by: z.enum(['contractor_trade', 'asset_category', 'text']).nullable(),
    }),
    summarize: (input, output) => (!output.found || !output.record
      ? `No ${input.trade} service on record yet`
      : `Last ${input.trade} service was ${output.record.title} on ${output.record.service_date}${output.contractor ? ` by ${output.contractor.name}` : output.record.provider ? ` by ${output.record.provider}` : ''}`),
    execute: async (scope, input) => {
      const res = await lastServiceByTrade(scope, input.trade);
      if (!res.ok) return res;
      const hit = res.data;
      if (!hit) return ok({ found: false, record: null, contractor: null, matched_by: null });
      const c = hit.contractor;
      return ok({
        found: true,
        record: { id: hit.record.id, title: hit.record.title, service_date: hit.record.service_date, provider: hit.record.provider, cost: hit.record.cost == null ? null : Number(hit.record.cost) },
        contractor: c ? { id: c.id, name: c.name, trade: c.trade, company: c.company, phone: c.phone, email: c.email, rating: c.rating, is_preferred: c.is_preferred, last_used_on: c.last_used_on } : null,
        matched_by: hit.matchedBy,
      });
    },
  }),

  defineTool({
    name: 'home.listOpenMaintenance',
    aliases: ['list_open_maintenance', 'maintenance_due'],
    description: 'Open home maintenance tasks, soonest due first.',
    domain: 'home_maintenance',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ due_before: z.string().nullish().describe('ISO 8601; only tasks due by then'), asset_id: z.string().nullish() }),
    output: z.object({
      tasks: z.array(z.object({ id: z.string(), title: z.string(), due_at: z.string().nullable(), when: z.string(), priority: z.string(), status: z.string(), asset_id: z.string().nullable(), assignee_id: z.string().nullable() })),
    }),
    summarize: (_input, output) => (output.tasks.length === 0
      ? 'No open maintenance tasks'
      : `${plural(output.tasks.length, 'open maintenance task')}; next is ${output.tasks[0].title} ${output.tasks[0].when}`),
    execute: async (scope, input) => {
      const res = await listOpenMaintenance(scope, { dueBefore: input.due_before ?? null, assetId: input.asset_id ?? null });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        tasks: res.data.map((t) => ({
          id: t.id, title: t.title, due_at: t.due_at, when: t.due_at ? describeWhen(t.due_at, scope.tz, now) : 'no due date',
          priority: t.priority, status: t.status, asset_id: t.asset_id, assignee_id: t.assignee_id,
        })),
      });
    },
  }),

  defineTool({
    name: 'home.saveContractor',
    aliases: ['save_contractor', 'add_contractor'],
    description: 'Save a contractor the family found or used, so they can be found again next time. Updates the existing entry when the name matches.',
    domain: 'home_maintenance',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      name: z.string(),
      trade: z.string().nullish(),
      company: z.string().nullish(),
      phone: z.string().nullish(),
      email: z.string().nullish(),
      website: z.string().nullish(),
      rating: z.number().int().nullish().describe('1 to 5'),
      is_preferred: z.boolean().nullish(),
      notes: z.string().nullish(),
    }),
    output: z.object({ id: z.string(), name: z.string(), trade: z.string().nullable(), created: z.boolean() }),
    idempotencyFrom: (input) => `home.saveContractor:${input.name.trim().toLowerCase()}`,
    summarize: (_input, output) => (output.created ? `Saved ${output.name}${output.trade ? ` (${output.trade})` : ''} to your contractors` : `Updated ${output.name} in your contractors`),
    resource: (output) => ({ table: 'home_contractors', id: output.id }),
    execute: async (scope, input) => {
      const res = await saveContractor(scope, {
        name: input.name, trade: input.trade ?? null, company: input.company ?? null, phone: input.phone ?? null, email: input.email ?? null,
        website: input.website ?? null, rating: input.rating ?? null, isPreferred: input.is_preferred ?? null, notes: input.notes ?? null,
      });
      if (!res.ok) return res;
      return ok({ id: res.data.contractor.id, name: res.data.contractor.name, trade: res.data.contractor.trade, created: res.data.created });
    },
  }),

  defineTool({
    name: 'home.createServiceRecord',
    aliases: ['log_home_service', 'add_service_record'],
    description: 'Log a completed service visit against the home or an asset, optionally naming the contractor who did it.',
    domain: 'home_maintenance',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string(),
      service_date: z.string().nullish().describe('YYYY-MM-DD; defaults to today'),
      asset_id: z.string().nullish(),
      contractor_id: z.string().nullish(),
      provider: z.string().nullish().describe('Who did the work, when not a saved contractor'),
      cost: z.number().nullish().describe('Dollars'),
      description: z.string().nullish(),
      next_due_on: z.string().nullish().describe('YYYY-MM-DD'),
    }),
    output: z.object({ id: z.string(), title: z.string(), service_date: z.string() }),
    idempotencyFrom: (input) => `home.createServiceRecord:${input.title.trim().toLowerCase()}:${input.service_date ?? 'today'}`,
    summarize: (_input, output) => `Logged ${output.title} on ${output.service_date}`,
    resource: (output) => ({ table: 'home_service_records', id: output.id }),
    execute: async (scope, input) => {
      const res = await createServiceRecord(scope, {
        title: input.title, serviceDate: input.service_date ?? null, assetId: input.asset_id ?? null, contractorId: input.contractor_id ?? null,
        provider: input.provider ?? null, cost: input.cost ?? null, description: input.description ?? null, nextDueOn: input.next_due_on ?? null,
      });
      if (!res.ok) return res;
      return ok({ id: res.data.id, title: res.data.title, service_date: res.data.service_date });
    },
  }),

  defineTool({
    name: 'home.createMaintenanceTask',
    aliases: ['create_maintenance_task', 'add_maintenance_task'],
    description: 'Add a home maintenance task, optionally due on a date, for an asset, assigned to someone.',
    domain: 'home_maintenance',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string(),
      description: z.string().nullish(),
      due_at: z.string().nullish().describe('ISO 8601'),
      asset_id: z.string().nullish(),
      assignee: z.string().nullish().describe('Family member name'),
      assignee_id: z.string().nullish(),
      priority: z.enum(['low', 'medium', 'high']).nullish(),
      interval_days: z.number().int().nullish().describe('Repeat every N days'),
    }),
    output: z.object({ id: z.string(), title: z.string(), due_at: z.string().nullable(), when: z.string(), assignee_id: z.string().nullable() }),
    idempotencyFrom: (input) => `home.createMaintenanceTask:${input.title.trim().toLowerCase()}:${input.asset_id ?? ''}`,
    summarize: (_input, output) => `Added maintenance task "${output.title}"${output.due_at ? ` due ${output.when}` : ''}`,
    resource: (output) => ({ table: 'maintenance_tasks', id: output.id }),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;
      const res = await createMaintenanceTask(scope, {
        title: input.title, description: input.description ?? null, dueAt: input.due_at ?? null, assetId: input.asset_id ?? null,
        assigneeId: assignee.data, priority: input.priority ?? null, intervalDays: input.interval_days ?? null,
      });
      if (!res.ok) return res;
      const t = res.data;
      return ok({ id: t.id, title: t.title, due_at: t.due_at, when: t.due_at ? describeWhen(t.due_at, scope.tz, scopeNow(scope)) : 'no due date', assignee_id: t.assignee_id });
    },
  }),
];
