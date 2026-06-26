import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center px-6 text-center">
      <p className="text-7xl font-bold gradient-text">404</p>
      <h1 className="mt-4 text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        The page you’re looking for doesn’t exist or may have moved. Here are a couple of ways back.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Link href="/dashboard"><Button>Go to dashboard</Button></Link>
        <Link href="/"><Button variant="outline">Back to home</Button></Link>
      </div>
    </div>
  );
}
