import Constants from 'expo-constants';

type Extra = { apiUrl?: string; supabaseUrl?: string; supabaseAnonKey?: string };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Runtime configuration. EXPO_PUBLIC_* env vars win over app.json `extra`. */
export const config = {
  /** The hosted web app — serves /api/ai and the account pages we deep-link to. */
  apiUrl: trimSlash(process.env.EXPO_PUBLIC_API_URL ?? extra.apiUrl ?? 'https://www.bubaly.com'),
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? extra.supabaseUrl ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? extra.supabaseAnonKey ?? '',
};

export const isSupabaseConfigured = (): boolean => Boolean(config.supabaseUrl && config.supabaseAnonKey);

export const webUrl = (path: string): string => `${config.apiUrl}${path.startsWith('/') ? path : `/${path}`}`;
