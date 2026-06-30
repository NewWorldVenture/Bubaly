import { AppFrame } from '@/components/app/app-frame';

// Food & Nutrition hub inherits the standard authenticated chrome.
export default function FoodLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
