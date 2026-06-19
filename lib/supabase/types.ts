// Client type aliases derived from the actual factory return types, so helpers stay
// consistent with whatever generic shape @supabase/ssr produces (avoids arity drift).
import type { createClient } from './client';
import type { createServer } from './server';

export type SupabaseBrowser = ReturnType<typeof createClient>;
export type SupabaseServer = Awaited<ReturnType<typeof createServer>>;
