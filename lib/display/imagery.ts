// lib/display/imagery.ts — curated photo fallbacks for the Kitchen Display
// (pure, tested; safe to import from server AND client code).
//
// The display should look photographic even before a family uploads a single
// photo or attaches images to recipes: the featured-recipe hero, the meals
// tile, the photo background, and the idle photo frame all fall back to a
// curated set of free-license Unsplash CDN images (hotlinking supported;
// every URL verified live with HTTP 200 before shipping). Real family/recipe
// photos always win — these only fill the gaps.

const img = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1600&q=80`;

// ── Recipe imagery ───────────────────────────────────────────────────────────
/** Keyword → dish photo. First match wins, so put specific dishes first. */
export const RECIPE_KEYWORD_IMAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btacos?\b|quesadilla|burrito/i,            img('photo-1565299585323-38d6b0865b47')],
  [/pizza/i,                                    img('photo-1513104890138-7c749659a591')],
  [/pasta|spaghetti|mac\s*(&|and)?\s*cheese|penne|lasagn/i, img('photo-1621996346565-e3dbc646d9a9')],
  [/salmon|fish|tuna|shrimp|seafood/i,          img('photo-1467003909585-2f8a72700288')],
  [/pancake|waffle|french toast/i,              img('photo-1567620905732-2d1ec7ab7445')],
  [/cheesecake|cake|cupcake/i,                  img('photo-1533134242443-d4fd215305ad')],
  [/burger|slider/i,                            img('photo-1568901346375-23c9450c58cd')],
  [/soup|ramen|pho\b/i,                         img('photo-1547592166-23ac45744acd')],
  [/salad|greens/i,                             img('photo-1512621776951-a57141f2eefd')],
  [/smoothie|shake|juice/i,                     img('photo-1502741224143-90386d7f8c82')],
  [/stir[-\s]?fry|rice|bowl|teriyaki/i,         img('photo-1512058564366-18510be2db19')],
  [/chili|stew|slow[-\s]?cooker|pot roast|curry/i, img('photo-1455619452474-d2be8b1e70cd')],
  [/egg|omelet|frittata/i,                      img('photo-1533089860892-a7c6f0a88666')],
  [/cookie|brownie|biscuit/i,                   img('photo-1499636136210-6f4ee915583e')],
  [/sandwich|wrap|sub\b|panini|toast/i,         img('photo-1528735602780-2552fd46c7af')],
  [/chicken|turkey/i,                           img('photo-1598103442097-8b74394b95c6')],
  [/fruit|apple|berry|banana/i,                 img('photo-1490474418585-ba9bad8fd0ea')],
];

/** Recipe category → photo, for when the name matches no keyword. */
export const RECIPE_CATEGORY_IMAGES: Readonly<Record<string, string>> = {
  breakfast: img('photo-1533089860892-a7c6f0a88666'),
  lunch:     img('photo-1528735602780-2552fd46c7af'),
  dinner:    img('photo-1414235077428-338989a2e8c0'),
  dessert:   img('photo-1551024506-0bccd828d307'),
  snack:     img('photo-1490474418585-ba9bad8fd0ea'),
  drink:     img('photo-1544145945-f90425340c7e'),
};

/** The always-appetizing default when nothing else matches. */
export const DEFAULT_FOOD_IMAGE = img('photo-1504674900247-0877df9cc836');

/**
 * Pick a photo for a recipe: its own photo if it has one, else a keyword match
 * on the name (Cheesecake → cheesecake, "Chicken Tacos" → tacos), else the
 * category dish photo, else the default plate. Never returns empty.
 */
export function recipeImage(name: string | null | undefined, category: string | null | undefined, own?: string | null): string {
  if (own && own.trim()) return own.trim();
  const n = (name ?? '').trim();
  if (n) {
    for (const [re, url] of RECIPE_KEYWORD_IMAGES) {
      if (re.test(n)) return url;
    }
  }
  const cat = (category ?? '').trim().toLowerCase();
  return RECIPE_CATEGORY_IMAGES[cat] ?? DEFAULT_FOOD_IMAGE;
}

// ── Meal-type thumbnails (the Meals tile) ────────────────────────────────────
export const MEAL_TYPE_IMAGES: Readonly<Record<string, string>> = {
  breakfast: img('photo-1533089860892-a7c6f0a88666'),
  lunch:     img('photo-1528735602780-2552fd46c7af'),
  dinner:    img('photo-1414235077428-338989a2e8c0'),
  snack:     img('photo-1490474418585-ba9bad8fd0ea'),
};

/** Thumbnail for a planned meal — the dish by name when possible, else the meal type. */
export function mealImage(name: string | null | undefined, mealType: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (n) {
    for (const [re, url] of RECIPE_KEYWORD_IMAGES) {
      if (re.test(n)) return url;
    }
  }
  return MEAL_TYPE_IMAGES[(mealType ?? '').toLowerCase()] ?? DEFAULT_FOOD_IMAGE;
}

// ── Ambient photo set (photo background + idle photo frame fallback) ─────────
/** Warm home/kitchen scenes used when the family has no photos yet. */
export const AMBIENT_FALLBACK_PHOTOS: readonly string[] = [
  img('photo-1556911220-bff31c812dba'),   // bright modern kitchen
  img('photo-1556910103-1c02745aae4d'),   // hands cooking together
  img('photo-1533920379810-6bedac961555'), // breakfast table, morning light
  img('photo-1495474472287-4d71bcdd2085'), // coffee pour
  img('photo-1530062845289-9109b2c9c868'), // set dinner table
  img('photo-1511895426328-dc8714191300'), // family at golden hour
  img('photo-1449844908441-8829872d2607'), // home at dusk
  img('photo-1416879595882-3373a0480b5b'), // garden greens
];
