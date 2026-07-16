import { AppFrame } from '@/components/app/app-frame';

// The Idea Board lives at the top-level /feedback URL (outside /dashboard), so it
// renders the shared authenticated AppFrame itself — same pattern as /wallet,
// /marketplace, and /missions — giving it the global left navigation + top bar
// instead of rendering full-bleed.
export default function FeedbackLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
