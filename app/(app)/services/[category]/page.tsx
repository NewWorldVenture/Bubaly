import type { Metadata } from 'next';
import { SERVICE_CATEGORY_BY_ID } from '@/lib/constants/service-categories';
import { ServiceCategoryView } from '@/components/services/service-category';
import { AppNotFound } from '@/components/app/app-not-found';

export async function generateMetadata({ params }: { params: Promise<{ category: string }> }): Promise<Metadata> {
  const { category } = await params;
  const cat = SERVICE_CATEGORY_BY_ID[category];
  return { title: cat ? `${cat.label} · Services` : 'Services' };
}

export default async function ServiceCategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  // Answered here, on the server: the view is a client component, and its own
  // notFound() threw inside app/(app)/loading.tsx's streamed boundary (React
  // #419 in the signed-in sweep).
  if (!SERVICE_CATEGORY_BY_ID[category]) return <AppNotFound backHref="/services" />;
  return <ServiceCategoryView categoryId={category} />;
}
