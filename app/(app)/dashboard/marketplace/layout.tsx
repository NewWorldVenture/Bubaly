import { MarketplaceNav } from '@/components/marketplace/marketplace-nav';

// Marketplace V2 section shell: the marketplace rail + content, rendered INSIDE
// the bubaly global frame (AppFrame comes from the dashboard layout above this).
export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl gap-5 px-4 py-6 sm:px-6">
      <aside className="hidden w-52 shrink-0 lg:block">
        <div className="sticky top-20">
          <MarketplaceNav />
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
