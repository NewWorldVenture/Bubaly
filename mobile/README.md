# Bubaly — Expo app

Native iOS / iPadOS / Android app for the family's daily loop (Today, Calendar,
Chores, Grocery, Assistant), built with Expo + expo-router on the **same design
tokens as the web app** (`../design/tokens.json`).

```bash
npm install
cp .env.example .env      # Supabase URL + anon key, web app URL
npx expo start
npm run typecheck
```

Full setup, architecture and release notes: [`../docs/mobile.md`](../docs/mobile.md).
Pure modules (theme resolution, secure-storage chunking, formatting, the
`/api/ai` contract) are unit-tested from the repo root: `npm test -- tests/mobile-core.test.ts`.

The assistant selects one of the seven supported base languages from the device
locale when opened or resumed. Its small bundled catalogue is generated from
`../lib/i18n/messages/*.json`; edit those source catalogues, then run
`node scripts/generate-mobile-assistant-messages.mjs` from the repository root.
The root test suite checks reproducibility, placeholder parity and permission
copy. `--check` verifies the generated file without writing. Expo's dynamic
config uses the same catalogue for iOS microphone permission prompts.

Recording, transcription and typed sends share one turn controller. Reset,
account or household changes, leaving the assistant and backgrounding invalidate
the current turn, abort pending requests and release the recorder. A fresh family
read precedes recording and each send; the API also checks the optional
`X-Bubaly-Family-Id` assertion. Cancelling locally cannot undo a request already
accepted by the server. Device checks should exercise microphone permission,
tap-to-stop, navigation/background interruption and permission denial on iOS and
Android; unit tests do not substitute for native recording verification.
