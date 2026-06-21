# FamilyOS Mobile (iOS, iPadOS, Android)

FamilyOS ships to the App Store and Google Play as **native apps built with
[Capacitor](https://capacitorjs.com)**, plus an installable **PWA**. The native
shells wrap the same hosted, Supabase‑wired Next.js app — so there is **one
codebase, one data layer, and zero feature drift** between web and mobile. iPad
is covered by the iOS target (universal app).

> Why a Capacitor shell over the hosted app (not a static export)? FamilyOS is a
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
export CAP_SERVER_URL=https://www.theagoras.com   # or http://192.168.x.x:3000

npm run cap:sync              # copy config + plugins into the native projects
npm run cap:ios               # sync iOS and open Xcode  → run / archive
npm run cap:android           # sync Android and open Studio → run / bundle
```

In Xcode: set your Team + bundle id `com.theagoras.familyos`, then Product →
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
