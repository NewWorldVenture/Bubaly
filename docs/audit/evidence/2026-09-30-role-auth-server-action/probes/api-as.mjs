// Calls one API route with a Playwright storage state (or none) and prints status and body.
import { chromium } from '/home/user/Bubaly/node_modules/playwright/index.mjs';
const [storage, method, path, body] = process.argv.slice(2);
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3107';
const b = await chromium.launch({ executablePath: process.env.PAGE_AUDIT_CHROMIUM });
const ctx = await b.newContext({ storageState: storage === '-' ? undefined : storage });
const r = await ctx.request.fetch(BASE + path, { method, data: body ? JSON.parse(body) : undefined, headers: { origin: BASE } });
console.log(method, path, r.status(), (await r.text()).slice(0, 160).replace(/\s+/g, ' '));
await b.close();
