// An in-memory stand-in for the Supabase client, faithful enough to drive the
// whole AI loop (intake → planner → store → executor → tools → services →
// detail read) without a database.
//
// WHY THIS EXISTS: the per-module tests each hand their module a recording fake
// that replies from a fixed script, which is right for pinning one module's
// contract but cannot prove that the modules agree with each other — that the
// run the planner creates is the run the executor claims, that the step rows
// the store writes are the rows the executor reads, that a tool's ledger row
// and the service's household row both land under the same family. This fake
// keeps real tables, applies real filters and returns what was written, so a
// test can run the loop end to end and then read the tables back the way the
// run page does.
//
// It implements the PostgREST builder surface the repository's server code
// uses: from/select/insert/update/upsert/delete, the filter vocabulary
// (eq, neq, in, is, not, or, gt/gte/lt/lte, ilike/like, contains), order,
// limit, range, single, maybeSingle, thenable execution, and rpc through a
// handler map. Every result is `{ data, error, count }` — nothing throws, the
// way the real client behaves.
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

type PostgrestError = { code: string; message: string; details: string | null; hint: string | null };
type Reply = { data: unknown; error: PostgrestError | null; count: number | null; status: number; statusText: string };

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
type Predicate = (row: Row) => boolean;

export type InMemoryOptions = {
  /** Per-table unique column sets; a violating insert answers 23505 like Postgres. */
  uniques?: Record<string, string[][]>;
  /** Per-table column defaults applied on insert when the row leaves the column unset (what the migrations' `default` clauses do). */
  defaults?: Record<string, Row>;
  /** RPC handlers by function name. Unknown functions answer an error. */
  rpc?: Record<string, (args: Record<string, unknown>, db: InMemorySupabase) => unknown | Promise<unknown>>;
  /** Auth user id for `auth.getUser()`. */
  userId?: string | null;
  /**
   * PostgREST's `db-max-rows` — the server's own ceiling on ONE response,
   * 1,000 on a default Supabase project.
   *
   * The real server applies it silently: no error, no short-read signal, just
   * fewer rows than the table holds. Without it here, a fake answers every
   * unbounded select with the whole table and a job that reads the first
   * 1,000 households looks identical to one that reads them all. Set it and
   * the difference becomes visible. Unset means no cap, which is what every
   * existing test assumes.
   */
  maxRows?: number;
};

/**
 * Functions the real schema carries, served from the backing tables so a test
 * does not have to know they exist.
 *
 * `family_allergies` (0438) is the narrow door onto `medical_profiles`: after
 * that migration the table reads manager-or-self, and the meal planner and
 * grocery substituter — which need the WHOLE household's allergies, on the
 * caller's own client — go through this instead. Modelling it here rather than
 * in each test keeps the fake honest about the schema: a select on
 * `medical_profiles` and a call to this used to be interchangeable, and since
 * 0438 they are not.
 *
 * An explicit `rpc` option still wins, which is how a test says "this call
 * fails" or supplies rows the backing table does not hold.
 */
type RpcHandler = (args: Record<string, unknown>, db: InMemorySupabase) => unknown;

function normalizedMealName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function normalizedMealIngredients(value: unknown): { name: string; qty: string | null; unit: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line) => {
    if (typeof line === 'string') {
      const name = line.trim();
      return name ? [{ name, qty: null, unit: null }] : [];
    }
    if (!line || typeof line !== 'object' || Array.isArray(line)) return [];
    const row = line as Row;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) return [];
    const qty = row.quantity ?? row.qty;
    const unit = typeof row.unit === 'string' ? row.unit.trim() || null : null;
    return [{ name, qty: typeof qty === 'number' ? String(qty) : typeof qty === 'string' ? qty.trim() || null : null, unit }];
  });
}

function ensureMeal(args: Record<string, unknown>, db: InMemorySupabase, actorId: unknown) {
  const familyId = args.p_family_id;
  const name = typeof args.p_name === 'string' ? args.p_name.trim() : '';
  const mealType = typeof args.p_meal_type === 'string' ? args.p_meal_type : 'dinner';
  if (typeof familyId !== 'string' || !name) throw new Error('Invalid synthetic custom meal');
  const hasIngredients = args.p_has_ingredients === true;
  const hasRecipeUrl = args.p_has_recipe_url === true;
  const hasImageUrl = args.p_has_image_url === true;
  const hasNotes = args.p_has_notes === true;
  const ingredients = hasIngredients ? args.p_ingredients : [];
  const recipeUrl = hasRecipeUrl && typeof args.p_recipe_url === 'string' ? args.p_recipe_url.trim() || null : null;
  const imageUrl = hasImageUrl && typeof args.p_image_url === 'string' ? args.p_image_url.trim() || null : null;
  const notes = hasNotes && typeof args.p_notes === 'string' ? args.p_notes.trim() || null : null;
  const existing = db.table('meals').find((meal) => meal.family_id === familyId
    && normalizedMealName(meal.name) === normalizedMealName(name) && meal.meal_type === mealType
    && (!hasIngredients || JSON.stringify(normalizedMealIngredients(meal.ingredients)) === JSON.stringify(normalizedMealIngredients(ingredients)))
    && (!hasRecipeUrl || (meal.recipe_url ?? null) === recipeUrl)
    && (!hasImageUrl || (meal.image_url ?? null) === imageUrl)
    && (!hasNotes || (meal.notes ?? null) === notes));
  if (existing) return { meal: { ...existing }, created: false };
  const meal = db.withDefaults('meals', {
    family_id: familyId, name, meal_type: mealType, ingredients: ingredients ?? [],
    recipe_url: recipeUrl, image_url: imageUrl, notes, created_by: typeof actorId === 'string' ? actorId : null,
  });
  db.table('meals').push(meal);
  return { meal: { ...meal }, created: true };
}

function replaceMealSlots(args: Record<string, unknown>, db: InMemorySupabase, actorId: unknown) {
  const familyId = args.p_family_id;
  const entries = args.p_entries;
  if (typeof familyId !== 'string' || !Array.isArray(entries) || entries.length === 0) throw new Error('Invalid synthetic meal plan');
  const normalized = entries.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic meal-plan entry');
    const entry = value as Row;
    const meal = db.table('meals').find((row) => row.id === entry.meal_id && row.family_id === familyId);
    if (!meal) throw new Error('Meal is unavailable to this family');
    return { plan_date: entry.plan_date, meal_type: entry.meal_type ?? 'dinner', meal_id: meal.id };
  });
  const slots = new Set(normalized.map((entry) => `${entry.plan_date}|${entry.meal_type}`));
  const plans = db.table('meal_plans');
  const replaced = plans.filter((row) => row.family_id === familyId && slots.has(`${row.plan_date}|${row.meal_type}`)).length;
  db.replace('meal_plans', plans.filter((row) => !(row.family_id === familyId && slots.has(`${row.plan_date}|${row.meal_type}`))));
  const planned = normalized.map((entry) => db.withDefaults('meal_plans', {
    family_id: familyId, ...entry, created_by: typeof actorId === 'string' ? actorId : null,
  }));
  db.table('meal_plans').push(...planned);
  return { planned: planned.map((row) => ({ ...row })), replaced, replayed: false };
}

function removeMealSlot(args: Record<string, unknown>, db: InMemorySupabase) {
  const familyId = args.p_family_id;
  const planId = args.p_plan_id;
  const plans = db.table('meal_plans');
  const row = plans.find((plan) => plan.id === planId && plan.family_id === familyId);
  if (!row) throw new Error('Planned meal not found');
  db.replace('meal_plans', plans.filter((plan) => plan !== row));
  return { id: planId, plan_date: row.plan_date, meal_type: row.meal_type, replayed: false };
}

function delegatedPlan(args: Record<string, unknown>, db: InMemorySupabase) {
  const familyId = args.p_family_id;
  const actorId = args.p_actor_id;
  const entries = args.p_entries;
  if (typeof familyId !== 'string' || typeof actorId !== 'string' || !Array.isArray(entries)) throw new Error('Invalid synthetic delegated plan');
  let createdMeals = 0;
  const resolved = entries.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic delegated entry');
    const entry = value as Row;
    let mealId = typeof entry.meal_id === 'string' ? entry.meal_id : null;
    if (mealId) {
      if (!db.table('meals').some((meal) => meal.id === mealId && meal.family_id === familyId)) throw new Error('Meal is unavailable to this family');
    } else {
      let name = typeof entry.meal_name === 'string' ? entry.meal_name : '';
      let ingredients = entry.ingredients ?? [];
      let recipeUrl = entry.recipe_url ?? null;
      let imageUrl = entry.image_url ?? null;
      let notes = entry.notes ?? null;
      let hasIngredients = Object.hasOwn(entry, 'ingredients');
      let hasRecipeUrl = Object.hasOwn(entry, 'recipe_url');
      let hasImageUrl = Object.hasOwn(entry, 'image_url');
      let hasNotes = Object.hasOwn(entry, 'notes');
      if (typeof entry.recipe_id === 'string') {
        const recipe = db.table('family_recipes').find((row) => row.id === entry.recipe_id && row.family_id === familyId);
        if (!recipe) throw new Error('Recipe is unavailable to this family');
        name = String(recipe.name ?? '');
        ingredients = recipe.ingredients ?? [];
        recipeUrl = recipe.source_url ?? null;
        imageUrl = recipe.photo_url ?? null;
        notes = null;
        hasIngredients = hasRecipeUrl = hasImageUrl = true;
        hasNotes = false;
      }
      const ensured = ensureMeal({
        p_family_id: familyId, p_name: name, p_meal_type: entry.meal_type ?? 'dinner',
        p_ingredients: ingredients, p_recipe_url: recipeUrl, p_image_url: imageUrl, p_notes: notes,
        p_has_ingredients: hasIngredients, p_has_recipe_url: hasRecipeUrl,
        p_has_image_url: hasImageUrl, p_has_notes: hasNotes,
      }, db, actorId);
      if (ensured.created) createdMeals++;
      mealId = String(ensured.meal.id);
    }
    return { plan_date: entry.plan_date, meal_type: entry.meal_type ?? 'dinner', meal_id: mealId };
  });
  const result = replaceMealSlots({ p_family_id: familyId, p_entries: resolved }, db, actorId);
  return { ...result, created_meals: createdMeals };
}

const BUILT_IN_RPC: Record<string, RpcHandler> = {
  family_allergies: (args, db) => db.table('medical_profiles')
    .filter((row) => row.family_id === args.p_family_id)
    .map((row) => ({ member_id: row.member_id, allergies: row.allergies ?? null })),
  meal_ensure_custom: (args, db) => ensureMeal(args, db, db.authUserId),
  meal_plan_replace_slots: (args, db) => replaceMealSlots(args, db, db.authUserId),
  meal_plan_remove_slot: (args, db) => removeMealSlot(args, db),
  meal_plan_replace_slots_for_actor: (args, db) => delegatedPlan(args, db),
  meal_plan_remove_slot_for_actor: (args, db) => removeMealSlot(args, db),
  meal_cleanup_unreferenced_custom: (args, db) => {
    const familyId = args.p_family_id;
    const ids = Array.isArray(args.p_meal_ids) ? args.p_meal_ids : [];
    let deleted = 0, retained = 0;
    for (const id of new Set(ids)) {
      const meal = db.table('meals').find((row) => row.id === id && row.family_id === familyId);
      if (!meal) continue;
      const referenced = db.table('meal_plans').some((row) => row.meal_id === id)
        || db.table('grocery_items').some((row) => row.source_meal_id === id);
      if (referenced) retained++;
      else {
        db.replace('meals', db.table('meals').filter((row) => row !== meal));
        deleted++;
      }
    }
    return { deleted, retained_referenced: retained };
  },
};

function pgError(code: string, message: string): PostgrestError {
  return { code, message, details: null, hint: null };
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date || b instanceof Date) return new Date(a as string).getTime() - new Date(b as string).getTime();
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** A loose equality: PostgREST compares the column's text form with the filter's. */
function looseEq(value: unknown, wanted: unknown): boolean {
  if (value === wanted) return true;
  if (value === null || value === undefined || wanted === null || wanted === undefined) return false;
  return String(value) === String(wanted);
}

function parseFilterValue(raw: string): unknown {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** PostgreSQL jsonb @> contains nested objects, not object reference identities. */
function jsonContains(value: unknown, wanted: unknown): boolean {
  if (Array.isArray(value)) {
    return (Array.isArray(wanted) ? wanted : [wanted]).every((needle) => value.some((item) => jsonContains(item, needle)));
  }
  if (value && typeof value === 'object' && wanted && typeof wanted === 'object') {
    return Object.entries(wanted).every(([key, item]) => jsonContains((value as Row)[key], item));
  }
  return looseEq(value, wanted);
}

function operatorPredicate(column: string, op: string, wanted: unknown): Predicate {
  if (column.includes('->')) {
    const path = /^([a-zA-Z_]\w*)((?:->>?[a-zA-Z_]\w*)+)$/.exec(column);
    if (!path) throw new Error('[in-memory-supabase] unsupported JSON path');
    const steps = [...path[2].matchAll(/(->>?)([a-zA-Z_]\w*)/g)];
    if (steps.some((step, index) => step[1] === '->>' && index !== steps.length - 1)) throw new Error('[in-memory-supabase] unsupported JSON path');
    const predicate = operatorPredicate('__json_value', op, wanted);
    return row => {
      let value: unknown = row[path[1]];
      for (const step of steps) value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row)[step[2]] : null;
      return predicate({ __json_value: value == null ? null : steps.at(-1)?.[1] !== '->>' ? value
        : typeof value === 'object' ? JSON.stringify(value) : String(value) });
    };
  }
  switch (op) {
    case 'eq': return (row) => {
      const value = row[column];
      if (value && typeof value === 'object' && typeof wanted === 'string') {
        try { return equalJson(value, JSON.parse(wanted)); } catch { return false; }
      }
      return looseEq(value, wanted);
    };
    case 'neq': return (row) => !looseEq(row[column], wanted);
    case 'is': return (row) => (row[column] ?? null) === wanted;
    case 'gt': return (row) => row[column] != null && compare(row[column], wanted) > 0;
    case 'gte': return (row) => row[column] != null && compare(row[column], wanted) >= 0;
    case 'lt': return (row) => row[column] != null && compare(row[column], wanted) < 0;
    case 'lte': return (row) => row[column] != null && compare(row[column], wanted) <= 0;
    case 'in': {
      const values = Array.isArray(wanted)
        ? wanted
        : String(wanted).replace(/^\(/, '').replace(/\)$/, '').split(',').map((v) => parseFilterValue(v.trim().replace(/^"|"$/g, '')));
      return (row) => values.some((v) => looseEq(row[column], v));
    }
    case 'like':
    case 'ilike': {
      const source = String(wanted).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      const re = new RegExp(`^${source}$`, op === 'ilike' ? 'i' : '');
      return (row) => typeof row[column] === 'string' && re.test(row[column] as string);
    }
    case 'cs':
    case 'contains': {
      return (row) => {
        const value = row[column];
        if (Array.isArray(value)) {
          const needles = Array.isArray(wanted) ? wanted : [wanted];
          return needles.every((n) => value.some((v) => looseEq(v, n)));
        }
        if (value && typeof value === 'object' && wanted && typeof wanted === 'object') {
          return jsonContains(value, wanted);
        }
        return false;
      };
    }
    case 'ov':
    case 'overlaps': {
      return (row) => {
        const value = row[column];
        const needles = Array.isArray(wanted) ? wanted : [wanted];
        return Array.isArray(value) && needles.some((n) => value.some((v) => looseEq(v, n)));
      };
    }
    default:
      throw new Error(`[in-memory-supabase] unsupported filter operator "${op}"`);
  }
}

/** jsonb equality ignores object-key order but preserves array order and scalar types. */
function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && equalJson((left as Row)[key], (right as Row)[key]));
}

/** `a.eq.1,b.is.null,c.in.(x,y)`, plus the nested `and(...)` groups used to
 *  filter typed calendar windows. A nested `or(...)` stays unsupported and
 *  throws — PostgREST's `.or()` already IS the or, and in-memory-supabase-logic
 *  pins that. */
function parseOr(expression: string, mode: 'or' | 'and' = 'or'): Predicate {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expression) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) throw new Error('[in-memory-supabase] unbalanced or() group');
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (depth !== 0) throw new Error('[in-memory-supabase] unbalanced or() group');
  if (current) parts.push(current);
  if (!current.trim() || parts.some(part => !part.trim())) throw new Error('[in-memory-supabase] empty or() clause');
  const predicates = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed.startsWith('and(') && trimmed.endsWith(')')) return parseOr(trimmed.slice(4, -1), 'and');
    const negated = trimmed.startsWith('not.');
    const body = negated ? trimmed.slice(4) : trimmed;
    if (body.startsWith('and(') && body.endsWith(')')) {
      const predicate = parseOr(body.slice(4, -1), 'and');
      return negated ? (row: Row) => !predicate(row) : predicate;
    }
    if (body.startsWith('or(')) throw new Error('[in-memory-supabase] nested or() is unsupported');
    const first = body.indexOf('.');
    const second = body.indexOf('.', first + 1);
    if (first < 0 || second < 0) throw new Error(`[in-memory-supabase] cannot parse or() clause "${part}"`);
    const column = body.slice(0, first);
    const op = body.slice(first + 1, second);
    const raw = body.slice(second + 1);
    const wanted = op === 'in' ? raw : parseFilterValue(raw);
    const predicate = operatorPredicate(column, op, wanted);
    return negated ? (row: Row) => !predicate(row) : predicate;
  });
  return (row) => mode === 'and' ? predicates.every((p) => p(row)) : predicates.some((p) => p(row));
}

/** Split a select list on top-level commas; `a, b:c, d(e,f)` → three parts. */
function splitSelect(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Project a row onto a select list. Embedded resources (`member:family_members(display_name)`)
 * resolve through a foreign key named `<alias>_id` or `<table singular>_id` when
 * one exists on the row, and are null otherwise — enough for the display joins
 * the services make.
 */
function project(db: InMemorySupabase, row: Row, select: string): Row {
  const parts = splitSelect(select.replace(/\s+/g, ' '));
  if (parts.length === 1 && parts[0] === '*') return { ...row };
  const out: Row = {};
  for (const part of parts) {
    if (part === '*') { Object.assign(out, row); continue; }
    const embed = /^(?:([\w]+):)?([\w]+)(?:!\w+)?\((.*)\)$/.exec(part);
    if (embed) {
      const alias = embed[1] ?? embed[2];
      const table = embed[2];
      const inner = embed[3] || '*';
      const fkCandidates = [`${alias}_id`, `${table.replace(/s$/, '')}_id`, `${table}_id`];
      const fk = fkCandidates.find((c) => c in row);
      const target = fk ? db.table(table).find((r) => looseEq(r.id, row[fk])) : undefined;
      out[alias] = target ? project(db, target, inner) : null;
      continue;
    }
    const aliased = /^([\w]+):([\w]+)(?:::\w+)?$/.exec(part);
    if (aliased) { out[aliased[1]] = row[aliased[2]] ?? null; continue; }
    const plain = part.replace(/::\w+$/, '');
    out[plain] = row[plain] ?? null;
  }
  return out;
}

class QueryBuilder implements PromiseLike<Reply> {
  private op: Op = 'select';
  private payload: Row[] = [];
  private upsertOn: string[] | null = null;
  private ignoreDuplicates = false;
  private readonly predicates: Predicate[] = [];
  private selectList: string | null = null;
  private countMode: 'exact' | 'planned' | 'estimated' | null = null;
  private headOnly = false;
  private orderings: { column: string; ascending: boolean; nullsFirst: boolean | null }[] = [];
  private limitCount: number | null = null;
  private rangeBounds: { from: number; to: number } | null = null;
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(private readonly db: InMemorySupabase, private readonly tableName: string) {}

  select(list = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    this.selectList = list;
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOn = opts?.onConflict ? opts.onConflict.split(',').map((c) => c.trim()) : ['id'];
    this.ignoreDuplicates = opts?.ignoreDuplicates === true;
    return this;
  }
  update(patch: Row, opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    this.op = 'update'; this.payload = [patch];
    if (opts?.count) this.countMode = opts.count;
    return this;
  }
  delete() { this.op = 'delete'; return this; }

  eq(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, value === null ? 'is' : 'eq', value)); return this; }
  neq(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'neq', value)); return this; }
  gt(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'gt', value)); return this; }
  gte(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'gte', value)); return this; }
  lt(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'lt', value)); return this; }
  lte(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'lte', value)); return this; }
  in(column: string, values: unknown[]) { this.predicates.push(operatorPredicate(column, 'in', values)); return this; }
  is(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'is', value)); return this; }
  like(column: string, pattern: string) { this.predicates.push(operatorPredicate(column, 'like', pattern)); return this; }
  ilike(column: string, pattern: string) { this.predicates.push(operatorPredicate(column, 'ilike', pattern)); return this; }
  contains(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'contains', value)); return this; }
  overlaps(column: string, value: unknown) { this.predicates.push(operatorPredicate(column, 'overlaps', value)); return this; }
  not(column: string, op: string, value: unknown) {
    const wanted = op === 'in' && typeof value === 'string' ? value : value;
    const predicate = operatorPredicate(column, op, wanted);
    this.predicates.push((row) => !predicate(row));
    return this;
  }
  or(expression: string) { this.predicates.push(parseOr(expression)); return this; }
  filter(column: string, op: string, value: unknown) { this.predicates.push(operatorPredicate(column, op, value)); return this; }
  match(query: Row) { for (const [k, v] of Object.entries(query)) this.eq(k, v); return this; }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderings.push({ column, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst ?? null });
    return this;
  }
  limit(count: number) { this.limitCount = count; return this; }
  range(from: number, to: number) { this.rangeBounds = { from, to }; return this; }
  abortSignal() { return this; }
  // Execution is synchronous and never retried. Do not imply retry support.
  retry(enabled: boolean) { if (enabled) throw new Error('[in-memory-supabase] retries are unsupported'); return this; }
  throwOnError() { return this; }

  single(): Promise<Reply> { this.mode = 'single'; return Promise.resolve(this.execute()); }
  maybeSingle(): Promise<Reply> { this.mode = 'maybeSingle'; return Promise.resolve(this.execute()); }

  then<R1 = Reply, R2 = never>(
    onFulfilled?: ((value: Reply) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private matching(): Row[] {
    return this.db.table(this.tableName).filter((row) => this.predicates.every((p) => p(row)));
  }

  private shape(rows: Row[]): Reply {
    let out = rows;
    if (this.orderings.length) {
      out = [...out].sort((a, b) => {
        for (const o of this.orderings) {
          const av = a[o.column] ?? null;
          const bv = b[o.column] ?? null;
          if (av === null && bv === null) continue;
          if (av === null) return (o.nullsFirst ?? !o.ascending) ? -1 : 1;
          if (bv === null) return (o.nullsFirst ?? !o.ascending) ? 1 : -1;
          const c = compare(av, bv);
          if (c !== 0) return o.ascending ? c : -c;
        }
        return 0;
      });
    }
    const total = out.length;
    if (this.rangeBounds) out = out.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    if (this.limitCount !== null) out = out.slice(0, this.limitCount);
    // Applied LAST and to every read alike: `db-max-rows` caps the response the
    // server is about to send, so it truncates a `.limit(5000)` exactly as
    // readily as an unbounded select. That is why `.limit()` is not a bound.
    const cap = this.db.maxRows;
    if (this.op === 'select' && cap !== undefined && out.length > cap) out = out.slice(0, cap);
    const projected = this.selectList ? out.map((row) => project(this.db, row, this.selectList as string)) : out.map((row) => ({ ...row }));
    const count = this.countMode ? total : null;
    if (this.headOnly) return { data: null, error: null, count, status: 200, statusText: 'OK' };
    if (this.mode === 'single') {
      if (projected.length !== 1) {
        return { data: null, error: pgError('PGRST116', `JSON object requested, multiple (or no) rows returned: ${projected.length}`), count, status: 406, statusText: 'Not Acceptable' };
      }
      return { data: projected[0], error: null, count, status: 200, statusText: 'OK' };
    }
    if (this.mode === 'maybeSingle') {
      if (projected.length > 1) {
        return { data: null, error: pgError('PGRST116', `JSON object requested, multiple (or no) rows returned: ${projected.length}`), count, status: 406, statusText: 'Not Acceptable' };
      }
      return { data: projected[0] ?? null, error: null, count, status: 200, statusText: 'OK' };
    }
    return { data: projected, error: null, count, status: 200, statusText: 'OK' };
  }

  private written(rows: Row[]): Reply {
    // Without an explicit `.select()`, PostgREST returns no representation.
    if (!this.selectList) return { data: null, error: null, count: null, status: 201, statusText: 'Created' };
    return this.shape(rows);
  }

  private uniqueViolation(row: Row, existing: Row[]): PostgrestError | null {
    for (const columns of this.db.uniquesFor(this.tableName)) {
      if (columns.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = existing.find((other) => other !== row && columns.every((c) => looseEq(other[c], row[c])));
      if (clash) return pgError('23505', `duplicate key value violates unique constraint "${this.tableName}_${columns.join('_')}_key"`);
    }
    return null;
  }

  private execute(): Reply {
    const table = this.db.table(this.tableName);
    switch (this.op) {
      case 'select':
        return this.shape(this.matching());
      case 'insert': {
        const inserted: Row[] = [];
        for (const raw of this.payload) {
          const row = this.db.withDefaults(this.tableName, raw);
          const violation = this.uniqueViolation(row, table);
          if (violation) return { data: null, error: violation, count: null, status: 409, statusText: 'Conflict' };
          table.push(row);
          inserted.push(row);
        }
        return this.written(inserted);
      }
      case 'upsert': {
        const touched: Row[] = [];
        for (const raw of this.payload) {
          const keys = this.upsertOn ?? ['id'];
          const existing = keys.every((k) => raw[k] !== undefined)
            ? table.find((other) => keys.every((k) => looseEq(other[k], raw[k])))
            : undefined;
          if (existing) {
            if (this.ignoreDuplicates) continue;
            Object.assign(existing, raw, { updated_at: new Date().toISOString() });
            touched.push(existing);
          } else {
            const row = this.db.withDefaults(this.tableName, raw);
            table.push(row);
            touched.push(row);
          }
        }
        return this.written(touched);
      }
      case 'update': {
        const rows = this.matching();
        const patch = this.payload[0] ?? {};
        for (const row of rows) Object.assign(row, patch);
        return this.written(rows);
      }
      case 'delete': {
        const rows = this.matching();
        this.db.replace(this.tableName, table.filter((row) => !rows.includes(row)));
        return this.written(rows);
      }
    }
  }
}

export class InMemorySupabase {
  private readonly tables = new Map<string, Row[]>();
  /** Every builder created, in order — a test can assert what was touched. */
  readonly log: { table: string }[] = [];

  constructor(private readonly options: InMemoryOptions = {}) {}

  /** The server's per-response row ceiling, or undefined for no cap. */
  get maxRows(): number | undefined { return this.options.maxRows; }
  get authUserId(): string | null { return this.options.userId ?? null; }

  from(table: string): QueryBuilder {
    this.log.push({ table });
    return new QueryBuilder(this, table);
  }

  async rpc(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const handler = this.options.rpc?.[name] ?? BUILT_IN_RPC[name];
    if (!handler) return { data: null, error: pgError('42883', `function ${name} does not exist`), count: null, status: 404, statusText: 'Not Found' };
    try {
      const data = await handler(args, this);
      return { data, error: null, count: null, status: 200, statusText: 'OK' };
    } catch (error) {
      return { data: null, error: pgError('P0001', error instanceof Error ? error.message : String(error)), count: null, status: 400, statusText: 'Bad Request' };
    }
  }

  readonly auth = {
    getUser: async () => ({ data: { user: this.options.userId ? { id: this.options.userId } : null }, error: null }),
  };

  /** Direct access for seeding and assertions. Rows are live objects. */
  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) { rows = []; this.tables.set(name, rows); }
    return rows;
  }

  seed(name: string, rows: Row[]): void {
    for (const row of rows) this.table(name).push(this.withDefaults(name, row));
  }

  replace(name: string, rows: Row[]): void { this.tables.set(name, rows); }

  /**
   * Empty every table, so one instance can serve a suite that seeds the same
   * household per case. The mocked `createServiceClient` closes over a single
   * client, so tests cannot simply build a new one between cases.
   */
  reset(): void { this.tables.clear(); this.log.length = 0; }

  uniquesFor(name: string): string[][] { return this.options.uniques?.[name] ?? []; }

  /** The defaults every migration in this repository gives its tables: a uuid id and timestamps. */
  withDefaults(table: string, raw: Row): Row {
    const now = new Date().toISOString();
    const row: Row = { ...raw };
    for (const [column, value] of Object.entries(this.options.defaults?.[table] ?? {})) {
      if (row[column] === undefined) row[column] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
    }
    if (row.id === undefined || row.id === null) row.id = randomUUID();
    if (row.created_at === undefined) row.created_at = now;
    if (row.updated_at === undefined) row.updated_at = now;
    return row;
  }
}

/** Build one, typed as the client the server code expects. */
export function createInMemorySupabase<T = unknown>(options: InMemoryOptions = {}): InMemorySupabase & T {
  return new InMemorySupabase(options) as InMemorySupabase & T;
}
