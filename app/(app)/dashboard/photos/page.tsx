import type { Metadata } from 'next';
import { PhotosModule } from '@/components/modules/photos-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('photosModule.familyPhotos') };
}

export default function PhotosPage() {
  return <PhotosModule />;
}
