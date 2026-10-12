import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { RecipesModule } from '@/components/modules/recipes-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('recipes.familyRecipes') };
}

export default async function RecipesPage() {
  // The sidebar resolves Recipes by its catalog tier, so an admin switching it
  // Off (or raising it) hid or locked the entry — and the URL still rendered the
  // whole module. The page answers to the same tier as the nav, like every
  // other household page; at the shipped Free tier this passes everyone.
  await requireFeature('/dashboard/recipes');
  return <RecipesModule />;
}
