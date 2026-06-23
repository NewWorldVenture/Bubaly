import { Megaphone } from 'lucide-react';
import { MarketingSubnav } from './marketing-subnav';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Megaphone className="h-5 w-5 text-brand" />
        <h1 className="text-lg font-bold">Marketing</h1>
      </div>
      <MarketingSubnav />
      {children}
    </div>
  );
}
