# Published preview: bounded anonymous verification

Inspected 2026-09-12, 14:24–14:26 UTC. **Deployment success is confirmed by metadata; application behavior could not be tested because Vercel Authentication intercepts the preview.** This lane stopped after the bounded anonymous probes. No sign-in, protection bypass, writes, configuration changes or provider operations were performed.

## Exact provenance

- [PR 510](https://github.com/NewWorldVenture/Bubaly/pull/510) reported published head `19a6907fdf906de3d44da583f2aa87a88298e697` through `gh pr view 510 --json url,headRefOid,statusCheckRollup`.
- The Vercel commit check was successful at **14:06:55 UTC**, pointing to [deployment HmqcnJeVVasmxva9fJVWUy1kYLe4](https://vercel.com/newworldventure/bubaly/HmqcnJeVVasmxva9fJVWUy1kYLe4).
- GitHub deployment **6410489889** has that exact SHA, environment `Preview`, and creator `vercel[bot]`. Its status **18264363927**, created at **14:06:55 UTC**, reports `success` / “Deployment has completed.” These were read from GitHub's deployments and deployment-status endpoints.
- The status supplies the deployment-specific URL [bubaly-cjoovxvi9-newworldventure.vercel.app](https://bubaly-cjoovxvi9-newworldventure.vercel.app/), which was used for the probes. The bot's latest PR comment also lists [the branch preview alias](https://bubaly-git-codex-final-production-audit-53f775-newworldventure.vercel.app/). That alias can move; the deployment-specific URL and SHA above establish this check's provenance.
- This preview predates the local social/rewards source commits `d8b276db` and `6094eb04`. These probes do not verify those newer changes.

## Observable HTTP and browser results

Node GET probes used manual redirects, a 15-second timeout and a 64-KiB body cap for `/`, `/api/health`, `/robots.txt`, `/dashboard` and `/admin`. All failed before receiving an HTTP response with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / “unable to verify the first certificate.” A bounded HEAD check on both deployment and branch-alias hosts reproduced the same local TLS-chain error. TLS verification was not disabled. The web reader independently could not open the deployment URL; that tool result is not evidence of an application failure.

Chromium used a fresh anonymous context with ordinary certificate verification. Only GET/HEAD requests were allowed, and no non-read requests were attempted. The initial home navigation ended at **https://vercel.com/login**, HTTP **200**, title **“Login – Vercel”**, with the authentication gate visible. Its intermediate navigation statuses were not captured in that first probe.

The four remaining paths were each navigated once in bounded browser checks:

| Requested path | Observed navigation chain | Application observable? |
| --- | --- | --- |
| `/api/health` | Preview **302** → Vercel `/sso-api` **307** → Vercel `/login` **200** | No readiness JSON reached |
| `/robots.txt` | Preview **302** → Vercel `/sso-api` **307** → Vercel `/login` **200** | No application robots content reached |
| `/dashboard` | Preview **302** → Vercel `/sso-api` **307** → Vercel `/login` **200** | Application session redirect not reached |
| `/admin` | Preview **302** → Vercel `/sso-api` **307** → Vercel `/login` **200** | Application admin/session guard not reached |

SSO nonce and redirect query values were omitted from recorded output. Home produced no observed console messages or page errors; the four remaining navigations produced no page errors. These observations concern Vercel's gate, not the Bubaly JavaScript bundle. They cannot establish a clean application console, hydration, navigation, login persistence or database health.

`app/api/health/route.ts` is the repository's intended public readiness endpoint, and `app/robots.ts` defines the robots response. The deployment protection layer prevented both from being observed anonymously. A successful Vercel build plus this protection response is neither a full application pass nor evidence that those routes are broken. Authorized preview access or a separately authorized protection change is an external dependency; neither was attempted here.
