import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { RecipesModule } from '@/components/modules/recipes-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('recipes.familyRecipes') };
}

export default function RecipesPage() {
  return <RecipesModule />;
}
