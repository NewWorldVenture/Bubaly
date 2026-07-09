// Marketplace V2 section wrapper. The left rail now lives in the global AppShell
// <aside> (it swaps to the Marketplace rail on these routes), so this layout is
// just the padded content column — no second sidebar.
export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 sm:px-6">{children}</div>;
}
