# Family subscription pricing

The September 9, 2026 pricing change makes annual Family Basic exactly
**$9.99/month equivalent**, and annual Family+ exactly **$24.99/month equivalent**.
The annual base amount is charged once per year. Monthly subscriptions use the price
before the advertised annual saving:

| Plan | Monthly billing | Annual billing | Annual monthly equivalent |
| --- | --- | --- | --- |
| Family Basic | $12.04/month | $119.88/year | $9.99/month |
| Family+ | $30.11/month | $299.88/year | $24.99/month |

For each tier, divide the requested monthly equivalent by `0.83` and round to
cents for the monthly subscription. Multiply the requested monthly equivalent
by 12 for the annual subscription. The resulting savings round to 17%; cent
rounding prevents an exact 17% ratio. The annual price already includes the
saving. Do not add a second 17% coupon to implement this change.

## Canonical configuration

`lib/constants/family-prices.json` supplies the displayed cents through
`lib/constants/plans.ts`, and the billing price validation and known Stripe ID
history through `lib/billing/price-catalog.ts`. Public pricing, upgrade and
billing surfaces, plan value calculations and marketing generation use those
constants. Environment configuration still selects the Stripe price IDs.

Only the four recorded previous live IDs are translated to their replacement
for the same tier and billing period. Custom and test IDs, empty values and
environment precedence are preserved. Every checkout and plan change retrieves
the selected price using its actual Stripe client and requires the expected
active USD recurring amount, interval and quantity behavior before paid or
customer mutations. A failed read or mismatch returns an unavailable response.

Webhook recognition includes both current and historical IDs, alongside the
existing environment mapping. Price retirement must not remove renewal
entitlements for historical subscriptions.

## Verified live Stripe changes

The following prices were created and read back on September 9, 2026 (US Eastern)
in account `acct_1TNul7BrwQtGmNLk`. Each existing product now uses its new price as
the default. IDs are public configuration, not credentials.

| Environment variable | New live price | Product |
| --- | --- | --- |
| `STRIPE_PRICE_BASIC_MONTHLY` | `price_1UDvdiBrwQtGmNLkX5z9qCVv` | `prod_UjrXOMxV7D7ffG` |
| `STRIPE_PRICE_BASIC_ANNUAL` | `price_1UDvdiBrwQtGmNLkVBshMLgK` | `prod_UjrXv7BB5fgQHR` |
| `STRIPE_PRICE_PLUS_MONTHLY` | `price_1UDvdjBrwQtGmNLkZmtkzTMJ` | `prod_UjrXNc7bSBzq8c` |
| `STRIPE_PRICE_PLUS_ANNUAL` | `price_1UDvdjBrwQtGmNLkpBdccLge` | `prod_UjrYK34Dx9Htrk` |

All four are active, live USD prices with one month/year intervals, licensed
usage and per-unit billing. Existing tax behavior was preserved. Metadata records
`pricing_version=2026-09-09-annual-17` and the canonical plan key.

The complete subscription query for each previous price (`status=all`) returned
zero subscriptions. Active payment links and billing portal configurations had
no references to those four prices; all queries exhausted their pages. No
subscription, payment link or portal migration was needed at that checkpoint.
Existing customers were not charged by creating these prices.

## Deployment and remaining acceptance

At this checkpoint the live website still shows the previous prices. The four
previous Stripe prices remain active until the code rollout is verified, so an
older deployed checkout remains usable during the transition.

1. Integrate and deploy the reviewed pricing change through the repository's
   integration owner. Where production is configured with the recorded old IDs,
   the new code translates them immediately. Update the four environment values
   above to the new IDs for explicit configuration when deployment access permits.
2. Verify both billing periods on `/pricing`, the in-app upgrade modal and billing
   page, including the annual total and monthly equivalent. Verify all supported
   locales and that checkout uses the selected current ID and interval. Do not
   complete a live payment merely to validate configuration.
   Confirm the admin-selected checkout key and the environment key used by plan
   changes, cancellation and the customer portal reach the same Stripe account.
   Check the actual first-invoice total: the existing checkout can add a separately
   configured one-time service fee, while the plan-change checkout fallback does
   not. This change updates recurring plan prices and does not alter that fee
   policy. The portal uses its Stripe-side configuration.
3. Recheck old-price references for changes since the initial audit. Once the
   current production code and checkout mapping are confirmed, archive the four
   previous IDs listed in the JSON catalogue. Preserve historical webhook mapping.
4. Read back the new prices and defaults, record the deployed commit and timestamp,
   and verify the previous prices are inactive. Keep failed or inaccessible
   checks explicitly pending.

The available deployment credential does not reach Bubaly's Vercel project, so
production deployment and environment read-back are still pending owner access.
The separately supplied webhook endpoint belongs to another application and was
not changed. No credential or webhook signing secret belongs in this runbook.
