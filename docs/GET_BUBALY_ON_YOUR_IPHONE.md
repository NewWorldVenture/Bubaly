# Put Bubaly on your iPhone

Three ways to do this. **Way 1 is the easy one** — it takes about one minute, needs
no computer, and gives you the whole app. Start there.

| Way | How long | Do you need a computer? | What you get |
| --- | --- | --- | --- |
| **1. Add to Home Screen** | 1 minute | No | The whole app, full screen, own icon |
| **2. Expo Go** | 20 minutes | Yes (any laptop) | The smaller "daily stuff" app |
| **3. Build it in Xcode** | 1–2 hours | Yes, and it must be a **Mac** | A real App Store–style app |

---

## Way 1 — Add to Home Screen (start here)

You only need your iPhone.

1. Unlock your iPhone.
2. Open the **Safari** app. It's the blue compass icon.
   **It has to be Safari.** Chrome will not work properly for this.
3. Tap the address bar at the top and type:

   **www.bubaly.com**

   Then tap **Go** on the keyboard.
4. Wait for the page to finish loading.
5. Find the **Share button**. It's a square with an arrow pointing up out of it: `↑`
   It is usually at the **bottom** of the screen, in the middle.
6. Tap it. A menu slides up from the bottom.
7. Put your finger on the menu and **slide it upward** to see more choices.
8. Look for **Add to Home Screen** and tap it.
   *Don't see it? Slide further up, or tap "Edit Actions" at the very bottom and turn it on.*
9. A box appears with the name **Bubaly** in it. You can leave the name alone.
10. Tap **Add** in the top-right corner.

**Done.** Close Safari and look at your home screen. There's a new **Bubaly** icon.

Tap it. It opens like a real app — no address bar, no Safari buttons, and you'll
see the Bubaly logo on a dark screen while it starts up.

### Did it work?

- ✅ You see a Bubaly icon on your home screen
- ✅ Tapping it fills the whole screen (no address bar at the top)
- ✅ You see the dark loading screen with the logo before the app appears

If you still see the Safari address bar, you probably tapped "Add Bookmark"
instead of "Add to Home Screen". Delete it and try again from step 5.

### Turning it off

Press and hold the Bubaly icon → **Remove App** → **Delete from Home Screen**.
Nothing in your account is deleted. You can add it back any time.

---

## Way 2 — Expo Go

This runs the smaller companion app (Today, Calendar, Chores, Grocery, Assistant).
You need a laptop and your iPhone **on the same Wi-Fi**.

### On your iPhone

1. Open the **App Store**.
2. Search for **Expo Go**.
3. Install it. (It's free.)

### On the laptop

1. Open the **Terminal** app.
2. Go to the project's mobile folder:

   ```bash
   cd mobile
   ```
3. Install the pieces it needs (takes a few minutes):

   ```bash
   npm install
   ```
4. Make the settings file:

   ```bash
   cp .env.example .env
   ```
5. Open that new `.env` file and fill in the three values. Ask a grown-up with the
   Supabase login for these — they're in the Supabase dashboard under
   **Settings → API**:

   ```
   EXPO_PUBLIC_SUPABASE_URL=https://ltcxlbipiihclxwioyqj.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=(the long "anon public" key)
   EXPO_PUBLIC_API_URL=https://www.bubaly.com
   ```
6. Start it:

   ```bash
   npx expo start
   ```
7. A big **QR code** appears in the Terminal.

### Back on your iPhone

8. Open the **Camera** app and point it at the QR code on the laptop screen.
9. A yellow banner appears at the top. Tap it.
10. Expo Go opens and loads Bubaly. The first load takes about a minute.

**If nothing happens:** check both devices are on the same Wi-Fi. That's almost
always the problem.

---

## Way 3 — Build it in Xcode (needs a Mac)

This makes the real app. It only works on a **Mac** — not Windows, not an iPad.

### Get the tools first

1. Open the **App Store** on the Mac and install **Xcode**. It is very big
   (about 10 GB) and can take an hour. Start it and go do something else.
2. Open Xcode once so it can finish setting itself up. Agree to the licence.
3. Open **Terminal** and install one more helper:

   ```bash
   sudo gem install cocoapods
   ```

### Make the app

4. In Terminal, from the main project folder:

   ```bash
   npm install
   npm run cap:add:ios
   npm run cap:ios
   ```
5. Xcode opens by itself.

### Put it on your iPhone

6. Plug your iPhone into the Mac with a cable.
7. If your iPhone asks **"Trust This Computer?"** tap **Trust** and type your passcode.
8. In Xcode, click **App** in the left-hand list, then the **Signing & Capabilities** tab.
9. Next to **Team**, pick your Apple ID. If the list is empty, choose
   **Add an Account** and sign in with your Apple ID.
10. At the top of Xcode there's a box showing a device name. Click it and choose
    **your iPhone** from the list.
11. Click the **▶ Play** button in the top-left.
12. Wait. The first build takes 5–15 minutes. That's normal.

### One more step on the iPhone

The first time, your iPhone won't trust an app you built yourself:

13. On the iPhone: **Settings → General → VPN & Device Management**.
14. Tap your Apple ID under **Developer App**.
15. Tap **Trust**.
16. Now open Bubaly from your home screen.

**Note:** an app built with a free Apple ID stops working after **7 days**.
Just plug in and press ▶ again to refresh it. A paid Apple Developer account
($99/year) makes it last a year and unlocks TestFlight for sharing with others.

---

## Which one is really the app?

Way 1 and Way 3 are **the same Bubaly** — every feature, same login, same data.
Way 3 just wraps it so it can go in the App Store and use things like push
notifications.

Way 2 is a **smaller, separate app** with only the everyday screens.

So for testing, **Way 1 is genuinely enough.** Only do Way 3 when you're ready to
put Bubaly in the App Store.

---

## Words that might be confusing

- **PWA** — a website that installs like an app. That's Way 1.
- **Terminal** — the app where you type commands instead of clicking.
- **QR code** — the square barcode you point a camera at.
- **Bundle ID** — the app's secret name. Bubaly's is `com.bubaly.bubaly`.
  The Expo companion uses a different one, `com.bubaly.companion`, so both can
  be on the same iPhone at once.
- **Signing / Team** — Apple checking you're allowed to build the app.
