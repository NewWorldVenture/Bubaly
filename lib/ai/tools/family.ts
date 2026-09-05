// Roster tools: who is in this household, and turning the name a person said
// into the member id every other tool needs.
//
// WHY these are `tasks` in the trust taxonomy: `TRUST_DOMAINS` has no
// household-roster domain and inventing one would mean editing an enum every
// stored policy is written against. Roster reads exist to serve assignment —
// "add a task for Ava", "who is free Saturday" — so they are evaluated as the
// domain that consumes them. They are read-only and expose nothing a family
// member cannot already see on /dashboard/family.
//
// `resolveAssigneeId` lives here rather than in each domain file because
// "assignee" is the same idea everywhere it appears, and because a name that
// matches nobody must fail loudly: silently creating an unassigned task for a
// person the family named is how work disappears.
import 'server-only';
import { z } from 'zod';
import { getPreferences, getMembers, resolveMemberByName } from '@/lib/services/family';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { defineTool, plural, type ToolDefinition } from './types';

const memberShape = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  age: z.number().nullable(),
  can_manage: z.boolean(),
  /** False for a managed profile: there is no account to notify or assign an account-scoped row to. */
  has_login: z.boolean(),
});

/**
 * Resolve `assignee_id` (already an id) or `assignee` (a name the model or a
 * person used) to a `family_members.id`.
 *
 * Returns `ok(null)` only when neither was supplied — an unassigned item is a
 * legitimate request. A name nobody answers to is an error, not a null.
 */
export async function resolveAssigneeId(
  scope: ServiceScope,
  input: { assignee_id?: string | null; assignee?: string | null },
): Promise<ServiceResult<string | null>> {
  if (input.assignee_id) return ok(input.assignee_id);
  const name = input.assignee?.trim();
  if (!name) return ok(null);

  const match = await resolveMemberByName(scope, name);
  if (!match.ok) return match;
  if (!match.data) return fail(`There is nobody called ${name} in this family.`, { code: SERVICE_CODES.notFound });
  return ok(match.data.id);
}

export const familyTools: ToolDefinition[] = [
  defineTool({
    name: 'family.listMembers',
    aliases: ['list_family_members', 'get_family_members'],
    description: 'List the people in this family with their roles and ages. Use it before assigning anything to a person.',
    domain: 'tasks',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      include_inactive: z.boolean().nullish().describe('Include members who have left the family. Defaults to false.'),
    }),
    output: z.object({ members: z.array(memberShape) }),
    summarize: (_input, output) => `Looked up ${plural(output.members.length, 'family member')}`,
    execute: async (scope, input) => {
      const res = await getMembers(scope, { includeInactive: input.include_inactive ?? false });
      if (!res.ok) return res;
      return ok({
        members: res.data.map((m) => ({
          id: m.id, name: m.displayName, role: m.role, age: m.age, can_manage: m.canManage, has_login: m.hasLogin,
        })),
      });
    },
  }),

  defineTool({
    name: 'family.resolveMember',
    aliases: ['resolve_member', 'find_family_member'],
    description: 'Turn a name ("mom", "Ava") into a family member id. Returns null when nobody matches.',
    domain: 'tasks',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ name: z.string().describe('The name or nickname that was used') }),
    output: z.object({ member: memberShape.nullable() }),
    summarize: (input, output) => (output.member ? `Matched "${input.name}" to ${output.member.name}` : `No family member matches "${input.name}"`),
    execute: async (scope, input) => {
      const res = await resolveMemberByName(scope, input.name);
      if (!res.ok) return res;
      const m = res.data;
      return ok({
        member: m ? { id: m.id, name: m.displayName, role: m.role, age: m.age, can_manage: m.canManage, has_login: m.hasLogin } : null,
      });
    },
  }),

  defineTool({
    name: 'family.getPreferences',
    aliases: ['get_family_preferences'],
    description: "Read the family's name, timezone and the current member's notification preferences.",
    domain: 'tasks',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({}),
    output: z.object({
      family_name: z.string(),
      timezone: z.string(),
      push_enabled: z.boolean().nullable(),
      email_enabled: z.boolean().nullable(),
    }),
    summarize: (_input, output) => `Read the settings for ${output.family_name} (${output.timezone})`,
    execute: async (scope) => {
      const res = await getPreferences(scope);
      if (!res.ok) return res;
      return ok({
        family_name: res.data.familyName,
        timezone: res.data.timezone,
        push_enabled: res.data.user?.pushEnabled ?? null,
        email_enabled: res.data.user?.emailEnabled ?? null,
      });
    },
  }),
];
