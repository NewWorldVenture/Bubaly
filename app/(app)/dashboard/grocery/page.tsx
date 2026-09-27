import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { ShoppingModule } from '@/components/modules/shopping-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('trustDomain.shopping') };
}

export default async function GroceryPage() {
  const t = await getTranslations();
  // The lists module has no page title of its own (its headings are the list
  // sidebar and the open list); the route's h1 lives here, for screen readers.
  return (
    <>
      <h1 className="sr-only">{t('grocery.groceries')}</h1>
      <ShoppingModule />
    </>
  );
}
