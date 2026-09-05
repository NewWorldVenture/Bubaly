# Bubaly Mobile (iOS, iPadOS, Android)

Bubaly has two mobile tracks that share one data layer (Supabase, RLS as the
signed-in user) and one visual language (`design/tokens.json`):

1. **The Capacitor shell + PWA** (below) — the full web app, wrapped natively.
   100% feature parity, zero drift.
2. **The Expo app in [`mobile/`](../mobile)** — a native React Native app
   (expo-router) for the family's daily loop: Today, Calendar, Chores, Grocery
   and the AI Assistant. Built on the **same design tokens as the web** (dark
   default + light toggle, glass surfaces, brand palette) and talking to the
   assistant through the canonical `/api/ai` route with a bearer token.

## Expo app (`mobile/`)

| Layer | Files |
| --- | --- |
| Shared design tokens (web ⇄ mobile) | `design/tokens.json`, `design/tokens.ts`, `mobile/src/theme/*` (`tests/design-tokens.test.ts` keeps `app/globals.css` in sync) |
| Routes (expo-router) | `mobile/app/_layout.tsx` (protected routes), `mobile/app/(auth)/sign-in.tsx`, `mobile/app/(tabs)/{index,calendar,chores,grocery,assistant}.tsx`, `mobile/app/settings.tsx` |
| Supabase auth + data | `mobile/src/lib/supabase.ts` (session in Keychain/Keystore via `chunked-storage.ts`), `family.ts`, `queries.ts` |
| Assistant (`/api/ai`, JSON transport) | `mobile/src/lib/api.ts`, `assistant-core.ts` → `app/api/ai/route.ts` (`lib/supabase/bearer.ts` authenticates the token) |
| Unit tests (pure modules, run from the repo root) | `tests/mobile-core.test.ts` |
| CI | `.github/workflows/ci.yml` → job `mobile` (`npm ci`, `tsc --noEmit`, `expo config`) |

```bash
cd mobile
npm install
cp .env.example .env            # EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY / _API_URL
npx expo start                  # Expo Go or a dev client; press i / a for simulators
npm run typecheck
```

- **Auth**: email + password against the same Supabase project as the web. The
  session is stored in secure storage (chunked to stay under the 2 KB Keychain
  guidance). Sign-up, password reset and family setup deep-link to the web app.
- **Data**: every query runs under the user's JWT, so RLS is identical to the
  web. Chores are *submitted* from the app; approval and payouts remain
  manager/server decisions (migration 0223), exactly as on the web.
- **Assistant**: `POST /api/ai?mode=json` with `Authorization: Bearer <jwt>`.
  The web keeps using the SSE transport of the same route.
- **Theme**: dark by default, light toggle, or match the device — persisted in
  AsyncStorage under the same key the web uses in localStorage.
- **Release**: `npx eas build -p ios|android` (EAS) or `npx expo prebuild` +
  Xcode/Android Studio. `ios/`, `android/`, `.expo/` are git-ignored.
- **Monorepo note**: `metro.config.js` watches `../design` and pins module
  resolution to `mobile/node_modules` so the web app's React version is never
  picked up.

## Capacitor shell + PWA

The native shells wrap the same hosted, Supabase‑wired Next.js app — so there is
**one codebase, one data layer, and zero feature drift** between web and mobile.
iPad is covered by the iOS target (universal app).

> Why a Capacitor shell over the hosted app (not a static export)? Bubaly is a
> dynamic app: SSR, server actions, and Supabase auth over cookies. A static
> export would break that wiring. The shell loads the live app and adds native
> capabilities (push, status bar, splash, deep links, haptics) on top, keeping
> 100% of the existing Supabase integration intact.

## What's in the repo

| Layer | Files |
| --- | --- |
| Capacitor config | `capacitor.config.ts` |
| Native init (status bar, splash, back button, deep links) | `components/native/native-bootstrap.tsx`, `lib/native/capacitor.ts` |
| Push registration (web + native) | `components/native/push-registrar.tsx`, `components/native/enable-push-button.tsx`, `lib/push/web-client.ts` |
| Push storage + delivery | `supabase/migrations/0035_push_devices.sql`, `app/api/push/{subscribe,unsubscribe}/route.ts`, `lib/server/push.ts` |
| Push fan‑out wired into notifications | `app/api/cron/notifications/route.ts`, `app/api/notifications/generate/route.ts` |
| PWA install assets | `app/manifest.ts`, `public/icons/*`, `public/apple-touch-icon.png`, `scripts/generate-icons.mjs` |
| Service worker (offline + web push) | `public/sw.js` |

## One‑time setup on a Mac / dev machine

Native compilation requires platform SDKs that aren't in CI:

- **iOS / iPadOS**: macOS + Xcode + CocoaPods (`sudo gem install cocoapods`).
- **Android**: Android Studio + JDK 17.

```bash
npm install
npm run icons                 # (re)generate the PNG icon set from public/icon.svg
npm run cap:add:ios           # creates the ios/ Xcode project
npm run cap:add:android       # creates the android/ Studio project
```

`ios/` and `android/` are git‑ignored — they're generated per machine.

## Build & run

```bash
# Point the shell at production (default) or a LAN dev server:
export CAP_SERVER_URL=https://www.bubaly.com   # or http://192.168.x.x:3000

npm run cap:sync              # copy config + plugins into the native projects
npm run cap:ios               # sync iOS and open Xcode  → run / archive
npm run cap:android           # sync Android and open Studio → run / bundle
```

In Xcode: set your Team + bundle id `com.bubaly.bubaly`, then Product →
Archive → distribute to the App Store. In Android Studio: Build → Generate Signed
Bundle (`.aab`) → upload to Play Console.

## Push notifications

Push is fully wired to Supabase. Each device registers into `push_devices`
(own‑row RLS), and the notification engine delivers to every registered device,
marking each notification `sent_at` so nothing is pushed twice.

### Web Push (installed PWA)
1. Generate VAPID keys: `npx web-push generate-vapid-keys`
2. Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
3. Users opt in via the **Enable push notifications** button on
   `/dashboard/notifications`. Delivery is real (`web-push` + the SW `push`
   handler in `public/sw.js`).

### Native Push (iOS/Android)
1. Create a Firebase project; add iOS + Android apps.
2. iOS: upload your APNs key to Firebase (Firebase routes APNs).
3. Android: drop `google-services.json` into `android/app/`; iOS: add
   `GoogleService-Info.plist` in Xcode.
4. Set `FCM_SERVER_KEY` so `lib/server/push.ts` delivers to native tokens.
   `PushRegistrar` requests permission and stores the device token automatically
   on first launch.

Without these credentials the system is honest: web/native sends are **skipped
and reported**, never silently dropped or faked.

## Migrations

Apply the two new migrations with the rest:

```bash
npm run db:push     # or: supabase db reset
```

- `0034_social_command_center.sql` — Social Command Center
- `0035_push_devices.sql` — push device registry (this feature)
