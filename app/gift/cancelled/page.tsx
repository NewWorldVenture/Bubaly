import type { Metadata } from 'next';
import Link from 'next/link';
import { XCircle } from 'lucide-react';

export const metadata: Metadata = { title: 'Gift cancelled · Bubaly', robots: { index: false } };

export default function GiftCancelledPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-100">
        <XCircle className="h-10 w-10 text-red-500" />
      </div>
      <div>
        <h1 className="text-2xl font-bold">Payment cancelled</h1>
        <p className="mt-2 text-muted">No charge was made. You can go back and try again.</p>
      </div>
      <Link
        href="/"
        className="rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90"
      >
        Go back
      </Link>
    </div>
  );
}
