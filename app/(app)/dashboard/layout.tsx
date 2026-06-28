import { AppFrame } from '@/components/app/app-frame';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
