import { AppFrame } from '@/components/app/app-frame';

// Marketplace V2 lives at the top-level /marketplace URL (outside /dashboard), so
// it renders the shared authenticated AppFrame itself — same pattern as /wallet
// and /missions. The left rail lives in the global AppShell <aside> (it swaps to
// the Marketplace rail on these routes), so this is just the padded content
// column inside the frame — no second sidebar.
export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppFrame>
      <div className="px-4 py-6 sm:px-6">{children}</div>
    </AppFrame>
  );
}
