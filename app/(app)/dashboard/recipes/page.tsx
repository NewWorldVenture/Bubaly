import type { Metadata } from 'next';
import { RecipesModule } from '@/components/modules/recipes-module';

export const metadata: Metadata = { title: 'Family Recipes' };

export default function RecipesPage() {
  return <RecipesModule />;
}
