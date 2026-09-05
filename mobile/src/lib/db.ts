// Type-only view of the Supabase client so pure modules (family.ts, queries.ts)
// and the root unit tests can reference it without importing the runtime
// client — which pulls React Native's global types into whichever TypeScript
// program includes it.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../lib/database.types';

export type Db = SupabaseClient<Database>;
