// The catalogue of everything the AI is allowed to do.
//
// It is a closed set on purpose. `executeTool` looks a name up here and denies
// anything it does not find (§43's default-deny), so a model that hallucinates
// `finances.transferMoney` gets a refusal rather than an unhandled promise —
// and adding a capability means adding a definition with a domain, a risk tier
// and a schema, which is the whole point.
//
// THREE NAMES PER TOOL, one identity. The canonical name is dotted
// (`calendar.createEvent`); the legacy flat names (`create_calendar_event`, …)
// are aliases so stored `approval_requests.payload.name` values keep executing
// after this lands; and the underscored form (`calendar_createEvent`) resolves
// too, because OpenAI function names must match /^[a-zA-Z0-9_-]+$/ and the
// legacy adapter has to send something the API accepts. Lookup is
// case-insensitive because models are inconsistent about it and a case slip is
// not a reason to refuse a family's work.
//
// Registration throws on a collision instead of last-write-wins: two tools
// sharing a name is a bug that must fail in the test run, not a silently
// shadowed tool discovered when an approval executes the wrong thing.
import { calendarTools } from './calendar';
import { noteTools } from './notes';
import { familyTools } from './family';
import { routineTools } from './routines';
import { groceryTools } from './groceries';
import { mealTools } from './meals';
import { memoryTools } from './memory';
import { messageTools } from './messages';
import { notificationTools } from './notifications';
import { reminderTools } from './reminders';
import { taskTools } from './tasks';
import { financeTools } from './finances';
import { tripTools } from './trips';
import { travelImportTools } from './travel-import';
import { homeTools } from './home';
import { providerTools } from './providers';
import { inventoryTools } from './inventory';
import { movingTools } from './moving';
import { documentTools } from './documents';
import { schoolTools } from './school';
import { sportsTools } from './sports';
import type { ToolDefinition } from './types';

const REGISTRY = new Map<string, ToolDefinition>();
/** Every resolvable spelling → canonical name. Keys are lower-cased. */
const LOOKUP = new Map<string, string>();

/** The OpenAI-safe spelling of a dotted name: `calendar.createEvent` → `calendar_createEvent`. */
export function functionName(name: string): string {
  return name.replace(/\./g, '_');
}

function index(key: string, canonical: string): void {
  const lower = key.trim().toLowerCase();
  if (!lower) throw new Error(`[tool-registry] ${canonical} has an empty name or alias`);
  const existing = LOOKUP.get(lower);
  if (existing && existing !== canonical) {
    throw new Error(`[tool-registry] "${key}" is claimed by both ${existing} and ${canonical}`);
  }
  LOOKUP.set(lower, canonical);
}

function register(tool: ToolDefinition): void {
  if (REGISTRY.has(tool.name)) throw new Error(`[tool-registry] duplicate tool ${tool.name}`);
  REGISTRY.set(tool.name, tool);
  index(tool.name, tool.name);
  index(functionName(tool.name), tool.name);
  for (const alias of tool.aliases ?? []) index(alias, tool.name);
}

for (const tool of [...calendarTools, ...taskTools, ...groceryTools, ...mealTools, ...reminderTools, ...familyTools, ...notificationTools, ...memoryTools, ...messageTools, ...financeTools, ...tripTools, ...travelImportTools, ...homeTools, ...providerTools, ...inventoryTools, ...movingTools, ...documentTools, ...schoolTools, ...sportsTools, ...routineTools, ...noteTools]) {
  register(tool);
}

/** Resolve a canonical name, a legacy alias or an underscored function name. Null when unknown. */
export function getTool(nameOrAlias: string): ToolDefinition | null {
  if (typeof nameOrAlias !== 'string') return null;
  const canonical = LOOKUP.get(nameOrAlias.trim().toLowerCase());
  return canonical ? REGISTRY.get(canonical) ?? null : null;
}

/**
 * The tools matching a filter, in registration order (domain by domain), which
 * is also the order they are offered to the model — reads before the writes
 * that depend on them within each domain.
 */
export function listTools(opts?: { readOnly?: boolean; domains?: string[]; names?: string[] }): ToolDefinition[] {
  let tools = [...REGISTRY.values()];
  if (opts?.readOnly !== undefined) tools = tools.filter((tool) => tool.readOnly === opts.readOnly);
  if (opts?.domains?.length) {
    const wanted = new Set(opts.domains);
    tools = tools.filter((tool) => wanted.has(tool.domain));
  }
  if (opts?.names?.length) {
    // Resolved through `getTool` so a caller may pass legacy names here too.
    const wanted = new Set(opts.names.map((name) => getTool(name)?.name).filter(Boolean) as string[]);
    tools = tools.filter((tool) => wanted.has(tool.name));
  }
  return tools;
}

/** Canonical names only — what the /api/ai manifest and the planner's allow-list publish. */
export function toolNames(): string[] {
  return [...REGISTRY.keys()];
}

/** Every spelling that resolves, for diagnostics and for the planner's validation pass. */
export function toolAliases(): Record<string, string> {
  return Object.fromEntries(LOOKUP.entries());
}
