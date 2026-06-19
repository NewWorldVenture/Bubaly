import type { Metadata } from 'next';
import { MealsModule } from '@/components/modules/meals-module';

export const metadata: Metadata = { title: 'Meals' };

export default function MealsPage() {
  return <MealsModule />;
}
