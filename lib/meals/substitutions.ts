// lib/meals/substitutions.ts — swap an ingredient the household cannot or will
// not eat, and say why.
//
// The grocery delta (`planGroceryNeeds`) knew what the week's dishes needed and
// what the pantry already held, and nothing else: it would happily put peanut
// butter on the list of a family whose medical profile records a peanut
// allergy, and jasmine rice on the list of a family with a full bag of brown
// rice in the cupboard.
//
// Three rules, applied in that order, and EVERY swap carries a reason:
//
//   1. ALLERGY  — read from `medical_profiles.allergies` and from
//      `family_facts` rows whose label says allergy. A safe replacement is
//      used where one exists; where none does the line is dropped rather than
//      quietly swapped for something else that is also unsafe.
//   2. DISLIKE  — read from `family_facts` preferences. Swapped for another
//      member of the same ingredient family, never dropped when an equivalent
//      exists.
//   3. PANTRY   — an ingredient whose family already has a stocked member in
//      the pantry becomes that member, so the shop does not buy a second
//      version of something the family owns.
//
// Pure and dependency-free so it can be unit-tested against a table of cases
// and re-used from a client module without dragging the service layer in.

export type SubstitutionKind = 'allergy' | 'dislike' | 'pantry';

/**
 * Which sentence explains the swap. The English `reason` below is for logs, AI
 * output and server-side summaries; a SURFACE renders the catalogue string this
 * names, with `trigger` as its only placeholder, so a Dutch family reads Dutch.
 */
export type SubstitutionReasonKey =
  | 'allergySwap' | 'allergyDropped' | 'dislikeSwap' | 'dislikeDropped' | 'pantrySwap';

/** The shape both `planGroceryNeeds` output and a hand-built list satisfy. */
export interface SubstitutionItem {
  name: string;
  quantity?: string | null;
  category?: string | null;
  sourceMealId?: string | null;
}

export interface Substitution {
  /** The ingredient the plan asked for. */
  from: string;
  /** What went on the list instead, or null when nothing safe exists and the line was dropped. */
  to: string | null;
  kind: SubstitutionKind;
  /** The household fact that caused it: the allergen, the disliked food, or the pantry item. */
  trigger: string;
  /** Which explanation applies, for a UI that has to say it in the family's language. */
  reasonKey: SubstitutionReasonKey;
  /** An English sentence. A swap is never shown without one. */
  reason: string;
}

export interface SubstitutionConstraints {
  /** Free-text allergy notes, already split into terms (see `parseConstraintText`). */
  allergies?: string[];
  /** Foods somebody in the house will not eat. */
  dislikes?: string[];
  /** What the pantry holds; only rows with stock above zero are preferred. */
  pantry?: { name: string; quantity?: number | null }[];
}

export interface SubstitutionResult {
  items: SubstitutionItem[];
  substitutions: Substitution[];
}

// ── normalisation ───────────────────────────────────────────────────────────

/**
 * Case, punctuation, a trailing plural and runs of whitespace are not
 * differences. Kept local rather than imported from the groceries service so
 * this module stays pure — the service is `server-only`.
 */
export function normalize(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\w)s$/, '$1');
}

/** Does `haystack` mention `needle` as a whole word (or word run)? */
function mentions(haystack: string, needle: string): boolean {
  const h = ` ${normalize(haystack)} `;
  const n = ` ${normalize(needle)} `;
  return h.includes(n);
}

/**
 * Split a free-text note — `medical_profiles.allergies` is one `text` column —
 * into terms. "Peanuts, tree nuts; shellfish and dairy" is four constraints,
 * not one.
 */
export function parseConstraintText(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/[,;/\n]|\band\b|\+/gi)
    .map((part) => part.replace(/\(.*?\)/g, ' ').trim())
    .map((part) => part.replace(/^(?:severe|mild|moderate|possible|suspected)\s+/i, '').trim())
    .filter((part) => part.length > 1 && /[a-z]/i.test(part))
    .filter((part) => !/^(?:none|n\/?a|no known|nka)$/i.test(part))
    .slice(0, 40);
}

// ── allergen table ──────────────────────────────────────────────────────────

interface AllergenRule {
  id: string;
  /** Words in the family's note that select this rule. */
  triggers: string[];
  /** Longest ingredient first; `null` means there is no safe swap and the line goes. */
  swaps: { ingredient: string; replacement: string | null }[];
  /**
   * Names that CONTAIN the allergen word and are nonetheless safe, because the
   * word is part of a compound that means the opposite: "oat milk" is not
   * milk, "gluten-free pasta" is not pasta a coeliac must avoid, "flax egg" is
   * not an egg.
   *
   * Without this every rule ate its own replacement — a dairy allergy swapped
   * milk for oat milk, then read "milk" in "oat milk" and dropped the line, so
   * a family with a dairy allergy got no milk of any kind on their list and no
   * explanation. It also protects an item the family already spelled safely: a
   * plan that names "gluten-free bread" is left exactly as written rather than
   * becoming "gluten-free gluten-free bread".
   *
   * It is a test on the WHOLE name, so it only ever says "this line is not
   * about my allergen". The inverse — a name whose modifier IS the allergen,
   * "whole wheat bread" under a gluten allergy — is not its job and it does
   * not handle it; `rewriteSafely` below does, by checking what the rewrite
   * left standing.
   */
  exempt?: RegExp;
}

const ALLERGEN_RULES: AllergenRule[] = [
  {
    id: 'peanut',
    triggers: ['peanut', 'peanuts', 'groundnut'],
    exempt: /\b(?:peanut[- ]free)\b/i,
    swaps: [
      { ingredient: 'peanut butter', replacement: 'sunflower seed butter' },
      { ingredient: 'peanut oil', replacement: 'canola oil' },
      { ingredient: 'peanuts', replacement: 'roasted sunflower seeds' },
      { ingredient: 'peanut', replacement: 'sunflower seed' },
    ],
  },
  {
    id: 'tree-nut',
    triggers: ['tree nut', 'tree nuts', 'nut', 'nuts', 'almond', 'almonds', 'cashew', 'cashews', 'walnut', 'walnuts', 'pecan', 'pecans', 'pistachio', 'hazelnut'],
    exempt: /\b(?:nut[- ]free)\b/i,
    swaps: [
      { ingredient: 'almond milk', replacement: 'oat milk' },
      { ingredient: 'almond flour', replacement: 'oat flour' },
      { ingredient: 'almond butter', replacement: 'sunflower seed butter' },
      { ingredient: 'pine nuts', replacement: 'pumpkin seeds' },
      { ingredient: 'almonds', replacement: 'pumpkin seeds' },
      { ingredient: 'cashews', replacement: 'sunflower seeds' },
      { ingredient: 'walnuts', replacement: 'pumpkin seeds' },
      { ingredient: 'pecans', replacement: 'pumpkin seeds' },
      { ingredient: 'pistachios', replacement: 'pumpkin seeds' },
      { ingredient: 'hazelnuts', replacement: 'pumpkin seeds' },
    ],
  },
  {
    id: 'dairy',
    triggers: ['dairy', 'milk', 'lactose', 'casein', 'cheese'],
    // Every plant milk and every "free-from" spelling. `almond` and `cashew`
    // are exempt HERE and still caught by the tree-nut rule, which is the
    // correct division: almond milk is safe for a dairy allergy and unsafe for
    // a nut one.
    //
    // The second and third alternatives are the word `butter` in the two
    // places it is not dairy at all. `butter` has to stay in the swap table —
    // a family that writes "butter" means the dairy one — but it is a
    // whole-WORD test, so without these a dairy allergy rewrote peanut
    // butter, apple butter, cocoa butter and butter lettuce into "peanut olive
    // oil", "apple olive oil", "cocoa olive oil" and "olive oil lettuce", and
    // wrote them to the family's list. The seed spellings matter twice over:
    // "sunflower seed butter" is the peanut rule's OWN replacement, and a
    // household allergic to both peanuts and dairy used to have it read as
    // dairy and lose the line entirely.
    exempt: /\b(?:oat|almond|soy|soya|rice|coconut|cashew|hemp|flax|pea|plant[- ]based|vegan|non[- ]dairy|dairy[- ]free|lactose[- ]free)\b|\b(?:peanut|apple|cocoa|shea|sunflower|pumpkin|nut|nuts|seed|seeds)[- ]?\s*butter\b|\bbutter\s+(?:lettuce|bean|beans|squash)\b/i,
    swaps: [
      { ingredient: 'heavy cream', replacement: 'coconut cream' },
      { ingredient: 'cream cheese', replacement: 'dairy-free cream cheese' },
      { ingredient: 'sour cream', replacement: 'coconut yogurt' },
      { ingredient: 'ice cream', replacement: 'dairy-free ice cream' },
      { ingredient: 'whole milk', replacement: 'oat milk' },
      { ingredient: 'cheddar cheese', replacement: 'dairy-free cheddar' },
      { ingredient: 'mozzarella cheese', replacement: 'dairy-free mozzarella' },
      { ingredient: 'greek yogurt', replacement: 'coconut yogurt' },
      { ingredient: 'parmesan', replacement: 'nutritional yeast' },
      { ingredient: 'mozzarella', replacement: 'dairy-free mozzarella' },
      { ingredient: 'butter', replacement: 'olive oil' },
      { ingredient: 'yogurt', replacement: 'coconut yogurt' },
      { ingredient: 'cheese', replacement: 'dairy-free cheese' },
      { ingredient: 'cream', replacement: 'oat cream' },
      { ingredient: 'milk', replacement: 'oat milk' },
    ],
  },
  {
    id: 'egg',
    triggers: ['egg', 'eggs'],
    exempt: /\b(?:egg[- ]free|flax|chia|aquafaba|vegan|plant[- ]based)\b/i,
    swaps: [
      { ingredient: 'mayonnaise', replacement: 'egg-free mayonnaise' },
      { ingredient: 'eggs', replacement: 'flax eggs' },
      { ingredient: 'egg', replacement: 'flax egg' },
    ],
  },
  {
    id: 'gluten',
    triggers: ['gluten', 'wheat', 'celiac', 'coeliac'],
    exempt: /\b(?:gluten[- ]free|wheat[- ]free|rice|corn|chickpea|lentil|almond|buckwheat|quinoa|tamari)\b/i,
    swaps: [
      { ingredient: 'all-purpose flour', replacement: 'gluten-free flour' },
      { ingredient: 'flour tortillas', replacement: 'corn tortillas' },
      { ingredient: 'bread crumbs', replacement: 'gluten-free bread crumbs' },
      { ingredient: 'breadcrumbs', replacement: 'gluten-free breadcrumbs' },
      { ingredient: 'soy sauce', replacement: 'tamari' },
      { ingredient: 'spaghetti', replacement: 'gluten-free spaghetti' },
      { ingredient: 'couscous', replacement: 'quinoa' },
      { ingredient: 'barley', replacement: 'rice' },
      { ingredient: 'pasta', replacement: 'gluten-free pasta' },
      { ingredient: 'bread', replacement: 'gluten-free bread' },
      { ingredient: 'flour', replacement: 'gluten-free flour' },
    ],
  },
  {
    id: 'soy',
    triggers: ['soy', 'soya', 'soybean'],
    exempt: /\b(?:soy[- ]free|coconut aminos)\b/i,
    swaps: [
      { ingredient: 'soy sauce', replacement: 'coconut aminos' },
      { ingredient: 'soy milk', replacement: 'oat milk' },
      { ingredient: 'edamame', replacement: 'peas' },
      { ingredient: 'tofu', replacement: 'chickpeas' },
    ],
  },
  {
    id: 'shellfish',
    triggers: ['shellfish', 'shrimp', 'prawn', 'prawns', 'crab', 'lobster', 'scallop', 'scallops'],
    // Nothing on a grocery list plays the part of shrimp in a dish without
    // changing it, so the honest move is to drop the line and say so rather
    // than invent a swap the cook did not ask for.
    swaps: [
      { ingredient: 'shrimp', replacement: null },
      { ingredient: 'prawns', replacement: null },
      { ingredient: 'crab', replacement: null },
      { ingredient: 'crab meat', replacement: null },
      { ingredient: 'lobster', replacement: null },
      { ingredient: 'scallops', replacement: null },
    ],
  },
  {
    id: 'fish',
    triggers: ['fish', 'salmon', 'tuna', 'cod', 'anchovy', 'anchovies'],
    exempt: /\b(?:fish[- ]free|vegan|plant[- ]based)\b/i,
    swaps: [
      { ingredient: 'fish sauce', replacement: 'coconut aminos' },
      { ingredient: 'anchovies', replacement: null },
      { ingredient: 'salmon', replacement: 'chicken breast' },
      { ingredient: 'tuna', replacement: 'chickpeas' },
      { ingredient: 'cod', replacement: 'chicken breast' },
    ],
  },
  {
    id: 'sesame',
    triggers: ['sesame', 'tahini'],
    exempt: /\b(?:sesame[- ]free)\b/i,
    swaps: [
      { ingredient: 'sesame seeds', replacement: 'poppy seeds' },
      { ingredient: 'sesame oil', replacement: 'olive oil' },
      { ingredient: 'tahini', replacement: 'sunflower seed butter' },
    ],
  },
];

/**
 * Ingredient families. One table serves two jobs: picking a stand-in for a
 * food somebody will not eat, and preferring the version already in the
 * cupboard over a near-identical one from the shop.
 */
const EQUIVALENT_GROUPS: string[][] = [
  ['white rice', 'brown rice', 'jasmine rice', 'basmati rice', 'quinoa', 'couscous'],
  ['spaghetti', 'penne', 'rotini', 'linguine', 'macaroni', 'pasta'],
  ['cilantro', 'parsley', 'basil'],
  ['olive oil', 'canola oil', 'avocado oil', 'vegetable oil'],
  ['black beans', 'pinto beans', 'kidney beans', 'chickpeas', 'white beans'],
  ['ground beef', 'ground turkey', 'ground chicken', 'ground pork'],
  ['chicken breast', 'chicken thighs'],
  ['whole milk', '2% milk', 'oat milk', 'almond milk', 'soy milk'],
  ['cheddar cheese', 'monterey jack cheese', 'mozzarella cheese'],
  ['red onion', 'yellow onion', 'white onion', 'shallot'],
  ['red bell pepper', 'green bell pepper', 'yellow bell pepper'],
  ['sweet potato', 'russet potato', 'potato'],
  ['broccoli', 'cauliflower', 'green beans'],
  ['lime', 'lemon'],
  ['sour cream', 'greek yogurt', 'plain yogurt'],
  ['maple syrup', 'honey'],
  ['baby spinach', 'spinach', 'kale', 'arugula'],
];

function groupFor(name: string): string[] | null {
  const key = normalize(name);
  for (const group of EQUIVALENT_GROUPS) {
    if (group.some((member) => normalize(member) === key)) return group;
  }
  return null;
}

/** The allergy rules a family's notes switch on. */
function activeRules(allergies: string[]): AllergenRule[] {
  const terms = (allergies ?? []).map(normalize).filter(Boolean);
  if (!terms.length) return [];
  return ALLERGEN_RULES.filter((rule) =>
    rule.triggers.some((trigger) => terms.some((term) => term === normalize(trigger) || mentions(term, trigger))));
}

/** The allergen term the family actually wrote, for the reason sentence. */
function triggerTerm(rule: AllergenRule, allergies: string[]): string {
  for (const term of allergies ?? []) {
    if (rule.triggers.some((trigger) => normalize(term) === normalize(trigger) || mentions(term, trigger))) return term.trim();
  }
  return rule.id;
}

interface AllergyHit { rule: AllergenRule; ingredient: string; replacement: string | null }

/** The longest allergen ingredient this item name mentions, across active rules. */
function findAllergyHit(name: string, rules: AllergenRule[]): AllergyHit | null {
  let best: AllergyHit | null = null;
  for (const rule of rules) {
    if (rule.exempt?.test(name)) continue;
    for (const swap of rule.swaps) {
      if (!mentions(name, swap.ingredient)) continue;
      if (!best || swap.ingredient.length > best.ingredient.length) {
        best = { rule, ingredient: swap.ingredient, replacement: swap.replacement };
      }
    }
  }
  return best;
}

function spanOf(ingredient: string): RegExp {
  return new RegExp(`\\b${ingredient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

/** Rewrite the matched span, so "shredded cheddar cheese" keeps "shredded". */
function rewrite(name: string, ingredient: string, replacement: string): string {
  const pattern = spanOf(ingredient);
  return pattern.test(name) ? name.replace(pattern, replacement).replace(/\s+/g, ' ').trim() : replacement;
}

/** What the rewrite would leave standing: the name with the matched span gone. */
function modifierOf(name: string, ingredient: string): string {
  const pattern = spanOf(ingredient);
  return pattern.test(name) ? name.replace(pattern, ' ').replace(/\s+/g, ' ').trim() : '';
}

/**
 * Does this fragment name the allergen itself — the word the family wrote for
 * it, or an ingredient this rule exists to swap away?
 *
 * Deliberately NOT `findAllergyHit`: that consults `exempt`, and by the time
 * this is asked the replacement has already put a "gluten-free" into the
 * string, which would exempt the whole line and hide the very thing being
 * looked for.
 */
function namesAllergen(fragment: string, rule: AllergenRule): boolean {
  if (!fragment.trim()) return false;
  return rule.triggers.some((trigger) => mentions(fragment, trigger))
    || rule.swaps.some((swap) => mentions(fragment, swap.ingredient));
}

/**
 * The swap, with the modifier checked.
 *
 * Rewriting only the matched span keeps the useful half of a name — "shredded
 * cheddar cheese" should still say "shredded". But when the modifier is itself
 * the allergen, keeping it produces a line that contradicts its own reason:
 * "whole wheat bread" became "whole wheat gluten-free bread", which was then
 * WRITTEN to a coeliac household's list, telling the shopper to buy wheat
 * bread that is also gluten-free. In that case the modifier goes and the
 * replacement stands alone.
 */
function rewriteSafely(name: string, hit: AllergyHit, replacement: string): string {
  if (namesAllergen(modifierOf(name, hit.ingredient), hit.rule)) return replacement;
  return rewrite(name, hit.ingredient, replacement);
}

function isUnsafe(name: string, rules: AllergenRule[]): boolean {
  return findAllergyHit(name, rules) !== null;
}

function isDisliked(name: string, dislikes: string[]): string | null {
  for (const dislike of dislikes ?? []) {
    const term = dislike.trim();
    if (term && mentions(name, term)) return term;
  }
  return null;
}

/**
 * Apply the three rules to a needed-items list.
 *
 * Items merge by normalised name AFTER swapping, so two dishes whose different
 * milks both become oat milk produce one line — with both quantities noted
 * rather than one silently dropped, the same honesty `planGroceryNeeds` keeps.
 */
export function applySubstitutions(
  items: SubstitutionItem[],
  constraints: SubstitutionConstraints = {},
): SubstitutionResult {
  const allergies = (constraints.allergies ?? []).map((a) => a.trim()).filter(Boolean);
  const dislikes = (constraints.dislikes ?? []).map((d) => d.trim()).filter(Boolean);
  const rules = activeRules(allergies);
  const stocked = (constraints.pantry ?? [])
    .filter((p) => p?.name && (p.quantity ?? 0) > 0)
    .map((p) => p.name.trim());
  const stockedKeys = new Set(stocked.map(normalize));

  const substitutions: Substitution[] = [];
  const out = new Map<string, SubstitutionItem>();

  const emit = (item: SubstitutionItem, name: string) => {
    const key = normalize(name);
    if (!key) return;
    const existing = out.get(key);
    if (!existing) {
      out.set(key, { ...item, name });
      return;
    }
    const qty = item.quantity?.trim();
    // These are separate requirements even when their amounts are equal or
    // one string contains the other. Keep unknown amounts explicit as well.
    existing.quantity = `${existing.quantity?.trim() || 'amount unspecified'} + ${qty || 'amount unspecified'}`;
  };

  for (const item of items ?? []) {
    const original = (item?.name ?? '').trim();
    if (!original) continue;

    // 1. Allergy — the only rule that can remove a line outright.
    const hit = findAllergyHit(original, rules);
    if (hit) {
      const trigger = triggerTerm(hit.rule, allergies);
      if (hit.replacement === null || isUnsafe(hit.replacement, rules)) {
        substitutions.push({
          from: original, to: null, kind: 'allergy', trigger, reasonKey: 'allergyDropped',
          reason: `Left off the list: ${original} contains ${hit.ingredient}, and the family records a ${trigger} allergy. No safe swap.`,
        });
        continue;
      }
      const swapped = rewriteSafely(original, hit, hit.replacement);
      substitutions.push({
        from: original, to: swapped, kind: 'allergy', trigger, reasonKey: 'allergySwap',
        reason: `Swapped for ${swapped}: ${original} contains ${hit.ingredient}, and the family records a ${trigger} allergy.`,
      });
      emit(item, swapped);
      continue;
    }

    // 2. Dislike — swap inside the ingredient family, drop only when there is no family.
    const dislike = isDisliked(original, dislikes);
    if (dislike) {
      const group = groupFor(original);
      const alternative = (group ?? []).find((member) =>
        normalize(member) !== normalize(original)
        && !isDisliked(member, dislikes)
        && !isUnsafe(member, rules));
      if (alternative) {
        substitutions.push({
          from: original, to: alternative, kind: 'dislike', trigger: dislike, reasonKey: 'dislikeSwap',
          reason: `Swapped for ${alternative}: the family has ${dislike} noted as a food nobody eats.`,
        });
        emit(item, alternative);
      } else {
        substitutions.push({
          from: original, to: null, kind: 'dislike', trigger: dislike, reasonKey: 'dislikeDropped',
          reason: `Left off the list: the family has ${dislike} noted as a food nobody eats, and there is no equivalent to put in its place.`,
        });
      }
      continue;
    }

    // 3. Pantry — buy the version already owned rather than a near-identical one.
    if (!stockedKeys.has(normalize(original))) {
      const group = groupFor(original);
      const inPantry = (group ?? []).find((member) =>
        normalize(member) !== normalize(original)
        && stockedKeys.has(normalize(member))
        && !isDisliked(member, dislikes)
        && !isUnsafe(member, rules));
      if (inPantry) {
        const pantryName = stocked.find((p) => normalize(p) === normalize(inPantry)) ?? inPantry;
        substitutions.push({
          from: original, to: pantryName, kind: 'pantry', trigger: pantryName, reasonKey: 'pantrySwap',
          reason: `Using the ${pantryName} already in your pantry instead of buying ${original}.`,
        });
        // The pantry already holds it, so nothing goes on the list.
        continue;
      }
    }

    emit(item, original);
  }

  return { items: [...out.values()], substitutions };
}

// ── reading the household's constraints ─────────────────────────────────────

/** `family_facts` rows, narrowed to the columns 0123 gives them. */
export interface FamilyFactRow {
  category?: string | null;
  label?: string | null;
  value?: string | null;
}

/** `medical_profiles` rows, narrowed to the one column that matters here. */
export interface MedicalProfileRow {
  allergies?: string | null;
}

const ALLERGY_LABEL = /allerg|intoleran|celiac|coeliac|anaphyla/i;
const DISLIKE_LABEL = /dislike|won'?t eat|will not eat|does ?n'?t eat|do not eat|nobody eats|no one eats|hates?|avoid|not a fan|picky about/i;

/**
 * Fold the two places a household records what it cannot eat into one pair of
 * lists. `medical_profiles.allergies` is a free-text column per member;
 * `family_facts` carries both allergies (as medical facts) and preferences.
 */
export function collectDietaryConstraints(input: {
  profiles?: MedicalProfileRow[];
  facts?: FamilyFactRow[];
}): { allergies: string[]; dislikes: string[] } {
  const allergies: string[] = [];
  const dislikes: string[] = [];

  for (const profile of input.profiles ?? []) {
    allergies.push(...parseConstraintText(profile?.allergies ?? null));
  }
  for (const fact of input.facts ?? []) {
    const label = fact?.label ?? '';
    const value = fact?.value ?? '';
    if (!value.trim()) continue;
    if (ALLERGY_LABEL.test(label)) allergies.push(...parseConstraintText(value));
    else if (DISLIKE_LABEL.test(label)) dislikes.push(...parseConstraintText(value));
  }

  const dedupe = (list: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const term of list) {
      const key = normalize(term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
    return out;
  };
  return { allergies: dedupe(allergies), dislikes: dedupe(dislikes) };
}

/** A one-line English summary of what was swapped, for a run note or a log. */
export function describeSubstitutions(substitutions: Substitution[]): string | null {
  if (!substitutions.length) return null;
  return substitutions
    .map((s) => (s.to ? `${s.from} → ${s.to}` : `${s.from} → left off`))
    .join('; ');
}
