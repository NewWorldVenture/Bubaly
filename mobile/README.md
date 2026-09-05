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
