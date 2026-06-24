import { requireFeature } from '@/lib/supabase/auth';
import { HomeSubnav } from '@/components/home/home-subnav';

export default async function HomeLayout({ children }: { children: React.ReactNode }) {
  await requireFeature('/dashboard/home');
  return (
    <div className="module-page">
      <HomeSubnav />
      {children}
    </div>
  );
}
