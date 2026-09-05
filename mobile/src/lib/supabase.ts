import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import type { Database } from '../../../lib/database.types';
import type { Db } from './db';
import { config } from './config';
import { createChunkedStore } from './chunked-storage';

export type Supabase = Db;

// Sessions live in the Keychain / Keystore (chunked, see chunked-storage.ts).
const secureSessionStore = createChunkedStore({
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
});

// The anon key + the user's JWT: every query runs under Row Level Security as
// that user, exactly like the web app. No service-role key ever ships here.
export const supabase: Supabase = createClient<Database>(
  config.supabaseUrl || 'https://placeholder.supabase.co',
  config.supabaseAnonKey || 'public-anon-key',
  {
    auth: {
      storage: secureSessionStore,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);

// Refresh tokens only while the app is in the foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
