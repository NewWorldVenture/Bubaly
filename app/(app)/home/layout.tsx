import { AppFrame } from '@/components/app/app-frame';

// /home reuses the standard authenticated chrome (sidebar, top bar, mobile nav).
export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
