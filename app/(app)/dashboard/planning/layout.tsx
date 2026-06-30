import { AppFrame } from '@/components/app/app-frame';

// Planning & Organization hub inherits the standard authenticated chrome.
export default function PlanningLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
