# Stripe Test Harness

A self-contained "fake website" for previewing the HYL Stripe checkout flow.
Runs entirely on your local machine. Uses fake Stripe + fake Supabase. Does
not touch the real haoyunlabs.com, the real Bankful integration, the real
Stripe account, or any real database.

## Why this exists

The user wants to see the architecture work end-to-end before any real
deployment. This harness:

- Serves a standalone HTML page that mimics the SPA's checkout form.
- Implements a Node mock backend that replicates the bridge → Stripe →
  webhook → paid state machine in-memory, with the same invariants the
  real edge functions enforce.
- Provides UI buttons for triggering each failure mode (bad signature,
  amount mismatch, expired bridge, replay) so you can see the system
  reject correctly.
- Streams the bridge state, stripe_callbacks, and checkout_attempt_log
  tables live to the page so you can watch the data layer respond.

## How to run

```sh
cd site/stripe-test
node server.mjs
```

Then open http://localhost:4242 in a browser.

No `npm install` needed — the server uses only Node built-ins.

## What it does NOT do

- Does not deploy to Supabase.
- Does not call Stripe's real API.
- Does not flip `stripe_card_provider_active`.
- Does not modify `site/index.html`, `admin/`, or anything else outside
  this `stripe-test/` directory.
- Does not handle real money. Fake card numbers only — Stripe's standard
  test cards (4242 4242 4242 4242) are simulated locally.

## What it shows

1. **Order form** — same shape as `submitOrder()` in production.
2. **Bridge layer** — live view of `checkout_bridge_sessions` row.
3. **Webhook log** — live view of `stripe_callbacks` rows.
4. **Attempt log** — live view of `checkout_attempt_log` (MAEF §9 style).
5. **Failure-mode buttons** — fire bad-signature / mismatched-amount /
   expired / replay scenarios and watch the rejection path.

## Relationship to the real code

The mock backend is a faithful Node port of the Deno edge function
logic — same invariants, same state machine, same column names. The
actual Deno code (in `admin/supabase/functions/stripe-checkout/` and
`stripe-webhook/`) is exercised by the Deno test suite at
`admin/supabase/functions/_tests/run.test.ts` (17 tests, all passing).

This harness is for visual demos. The Deno tests are the binding proof
of correctness.
