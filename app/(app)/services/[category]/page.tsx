import type { Metadata } from 'next';
import { SERVICE_CATEGORY_BY_ID } from '@/lib/constants/service-categories';
import { ServiceCategoryView } from '@/components/services/service-category';

export async function generateMetadata({ params }: { params: Promise<{ category: string }> }): Promise<Metadata> {
  const { category } = await params;
  const cat = SERVICE_CATEGORY_BY_ID[category];
  return { title: cat ? `${cat.label} · Services` : 'Services' };
}

export default async function ServiceCategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  return <ServiceCategoryView categoryId={category} />;
}
