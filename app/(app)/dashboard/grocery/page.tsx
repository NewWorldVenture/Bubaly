import type { Metadata } from 'next';
import { GroceryModule } from '@/components/modules/grocery-module';

export const metadata: Metadata = { title: 'Grocery' };

export default function GroceryPage() {
  return <GroceryModule />;
}
