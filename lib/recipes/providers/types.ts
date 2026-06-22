// Shared types for the recipe-provider architecture. Every external provider
// normalizes into NormalizedRecipe, whose ingredients/instructions match the
// existing family_recipes vault shape so imports render natively.

export type NormalizedIngredient = { name: string; quantity: string; unit: string };
export type NormalizedStep = { step: number; text: string };

export type NormalizedRecipe = {
  sourceProvider: string;   // 'themealdb' | 'usda' | …
  sourceRecipeId: string;
  sourceUrl: string | null;
  attribution: string;      // human-readable credit shown on the recipe
  licenseNotes: string;     // license/terms summary
  name: string;
  description: string | null;
  category: string;         // breakfast | lunch | dinner | dessert | snack | other…
  cuisine: string | null;
  photoUrl: string | null;
  tags: string[];
  ingredients: NormalizedIngredient[];
  instructions: NormalizedStep[];
  raw: unknown;             // original payload, stored for re-normalization/audit
};

/** A recipe provider adapter. All network calls happen server-side. */
export interface RecipeProvider {
  readonly id: string;
  readonly label: string;
  /** True when usable (e.g. has an API key). Keyless providers are always true. */
  isEnabled(): boolean;
  /** Free-text search → normalized recipes. */
  search(query: string, opts?: { limit?: number }): Promise<NormalizedRecipe[]>;
  /** Fetch a single recipe by its provider id, if supported. */
  lookup?(sourceRecipeId: string): Promise<NormalizedRecipe | null>;
}
