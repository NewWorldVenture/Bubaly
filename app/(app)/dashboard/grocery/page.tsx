import type { Metadata } from 'next';
import { ShoppingModule } from '@/components/modules/shopping-module';

export const metadata: Metadata = { title: 'Shopping' };

export default function GroceryPage() {
  return <ShoppingModule />;
}
