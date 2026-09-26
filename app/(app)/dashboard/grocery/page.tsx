import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { ShoppingModule } from '@/components/modules/shopping-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('trustDomain.shopping') };
}

export default function GroceryPage() {
  return <ShoppingModule />;
}
