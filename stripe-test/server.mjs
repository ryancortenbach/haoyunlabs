// HYL Stripe test harness — mock backend.
//
// Single-file Node server. Zero dependencies beyond Node built-ins.
// Mirrors the real edge function state machine in-memory so you can
// see the bridge → Stripe → webhook → paid flow without touching any
// real services.
//
// Usage:  node server.mjs
// Open:   http://localhost:4242

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const PORT = 4242;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------- Fake DB --------------------------------------

const db = {
  orders: [],
  customers: [],
  order_items: [],
  abandoned_checkouts: [],
  checkout_bridge_sessions: [],
  stripe_callbacks: [],
  checkout_attempt_log: [],
  discount_codes: [
    { code: "PENNY", percent_off: 99.99, active: true },
    { code: "ZARA20", percent_off: 20, active: true },
    { code: "SAVE10", percent_off: 10, active: true },
  ],
  affiliates: [
    { id: "aff-zara", code: "ZARA20", status: "active",
      discount_percent: 20, commission_rate: 10 },
  ],
};

const STRIPE_WEBHOOK_SECRET = "whsec_test_harness_local_only";
let logSeq = 1;

function logStage(orderNumber, stage, detail) {
  if (!orderNumber) return;
  db.checkout_attempt_log.push({
    id: logSeq++, order_number: orderNumber, stage, detail: detail ?? null,
    created_at: new Date().toISOString(),
  });
}

// --------------------- Pricing recompute -----------------------------
// Same rules as stripe-checkout/index.ts → recomputeTotalServerSide.

function recompute(input) {
  const { items, shipping, processingFee, discountAmount,
          discountCode, affiliateCode, discreetPackaging } = input;
  let resolvedAffiliateCode = affiliateCode || null;
  let resolvedAffiliateId = null;
  let serverDiscountPct = null;
  const rawLookup = (resolvedAffiliateCode || discountCode || "").trim();
  const codeWasSupplied = rawLookup.length > 0;
  const codeForLookup =
    rawLookup.length > 0 && rawLookup.length <= 32 && /^[A-Za-z0-9_-]+$/.test(rawLookup)
      ? rawLookup.toUpperCase() : "";
  if (codeForLookup) {
    const dc = db.discount_codes.find((r) => r.code === codeForLookup && r.active !== false);
    if (dc?.percent_off != null) {
      serverDiscountPct = Number(dc.percent_off);
    } else {
      const aff = db.affiliates.find((r) => r.code === codeForLookup && r.status === "active");
      if (aff) {
        resolvedAffiliateCode = aff.code;
        resolvedAffiliateId = aff.id;
        if (aff.discount_percent != null) serverDiscountPct = Number(aff.discount_percent);
      }
    }
  }
  const computedSubtotal = (items || []).reduce((s, it) => {
    const lt = Number(it?.lineTotal ?? Number(it?.unitPrice ?? 0) * Number(it?.quantity ?? 0));
    return s + (isFinite(lt) ? lt : 0);
  }, 0);
  let serverDiscountAmount;
  if (serverDiscountPct != null) {
    serverDiscountAmount = Math.round(computedSubtotal * (serverDiscountPct / 100) * 100) / 100;
  } else if (codeWasSupplied) {
    serverDiscountAmount = 0;
  } else {
    serverDiscountAmount = Number(discountAmount || 0);
  }
  const serverDiscreetSurcharge = discreetPackaging ? 5 : 0;
  const expectedTotal = Math.round(
    (computedSubtotal - serverDiscountAmount +
     Number(shipping || 0) + Number(processingFee || 0) +
     serverDiscreetSurcharge) * 100,
  ) / 100;
  return {
    computedSubtotal, serverDiscountAmount, serverDiscreetSurcharge,
    expectedTotal, resolvedAffiliateCode, resolvedAffiliateId,
  };
}

// ---------------------- Endpoints ------------------------------------

async function handleCheckout(body) {
  const orderNumber = String(body.orderNumber || "");
  logStage(orderNumber, "submit_received", { amount: body.amount, email: body.email });

  if (!orderNumber || !body.amount || !body.email || !body.fname || !body.lname ||
      !body.street || !body.city || !body.state || !body.zip || !body.phone) {
    logStage(orderNumber, "fail_missing_fields");
    return { status: 400, body: { ok: false, error: "Missing required fields" } };
  }

  if (db.orders.find((o) => o.order_number === orderNumber && o.status === "paid")) {
    return { status: 409, body: { ok: false, error: "Order already paid" } };
  }

  const existingBridge = db.checkout_bridge_sessions.find((b) => b.order_number === orderNumber);
  if (existingBridge?.status === "pending" && existingBridge.stripe_session_id &&
      new Date(existingBridge.expires_at) > new Date()) {
    logStage(orderNumber, "idempotent_replay", { session_id: existingBridge.stripe_session_id });
    return { status: 200, body: {
      ok: true, redirect_url: `/__stripe/${existingBridge.stripe_session_id}`,
      orderNumber,
    } };
  }

  const r = recompute({
    items: body.items, shipping: Number(body.shipping || 0),
    processingFee: Number(body.processingFee || 0),
    discountAmount: Number(body.discountAmount || 0),
    discountCode: body.discountCode, affiliateCode: body.affiliateCode,
    discreetPackaging: !!body.discreetPackaging,
  });
  const claimed = Number(body.amount);
  if (!isFinite(claimed) || claimed <= 0) {
    logStage(orderNumber, "fail_total_mismatch", { claimed });
    return { status: 400, body: { ok: false, error: "Invalid amount" } };
  }
  if (Math.abs(r.expectedTotal - claimed) > 0.05) {
    logStage(orderNumber, "fail_total_mismatch", { claimed, expected: r.expectedTotal });
    return { status: 400, body: { ok: false, error: "Total mismatch — refresh checkout and retry" } };
  }
  logStage(orderNumber, "total_verified", { expected: r.expectedTotal });

  // Customer + order + order_items + abandoned
  let customer = db.customers.find((c) => c.email === body.email);
  if (!customer) {
    customer = { id: crypto.randomUUID(), email: body.email, first_name: body.fname,
                 last_name: body.lname, phone: body.phone, street: body.street,
                 apt: body.apt || null, city: body.city, state: body.state, zip: body.zip };
    db.customers.push(customer);
  } else {
    Object.assign(customer, { first_name: body.fname, last_name: body.lname,
                              phone: body.phone, street: body.street, city: body.city,
                              state: body.state, zip: body.zip });
  }

  let order = db.orders.find((o) => o.order_number === orderNumber);
  if (!order) {
    order = { id: crypto.randomUUID(), order_number: orderNumber, customer_id: customer.id,
              created_at: new Date().toISOString() };
    db.orders.push(order);
  }
  Object.assign(order, {
    status: "awaiting_payment", payment_method: "stripe_card",
    subtotal: r.computedSubtotal, shipping: Number(body.shipping || 0),
    processing_fee: Number(body.processingFee) || 0,
    discount_amount: r.serverDiscountAmount, discount_code: body.discountCode || null,
    total: r.expectedTotal, items: body.items, discreet_packaging: !!body.discreetPackaging,
    affiliate_code: r.resolvedAffiliateCode, affiliate_id: r.resolvedAffiliateId,
    paid_at: order.paid_at ?? null,
  });

  db.order_items = db.order_items.filter((oi) => oi.order_id !== order.id);
  for (const it of body.items || []) {
    if (!it.sku) continue;
    db.order_items.push({
      id: crypto.randomUUID(), order_id: order.id, sku: it.sku, name: it.name || "",
      quantity: Number(it.quantity || 0),
      unit_price: Number(it.unitPrice ?? 0),
      line_total: Number(it.lineTotal ?? Number(it.unitPrice ?? 0) * Number(it.quantity ?? 0)),
    });
  }

  let ac = db.abandoned_checkouts.find((a) => a.order_number === orderNumber);
  if (!ac) {
    ac = { order_number: orderNumber, email: body.email, cart_items: body.items ?? [],
           recovery_url: "https://haoyunlabs.com/#order", recovered: false };
    db.abandoned_checkouts.push(ac);
  }

  // Bridge row — single source of verified truth.
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  let bridge = db.checkout_bridge_sessions.find((b) => b.order_number === orderNumber);
  if (!bridge) {
    bridge = { id: crypto.randomUUID(), order_number: orderNumber,
               created_at: new Date().toISOString() };
    db.checkout_bridge_sessions.push(bridge);
  }
  Object.assign(bridge, {
    status: "pending", customer_email: body.email, items: body.items,
    subtotal: r.computedSubtotal, shipping: Number(body.shipping || 0),
    discount_amount: r.serverDiscountAmount,
    processing_fee: Number(body.processingFee) || 0,
    discreet_surcharge: r.serverDiscreetSurcharge,
    total: r.expectedTotal,
    total_cents: Math.round(r.expectedTotal * 100),
    affiliate_code: r.resolvedAffiliateCode, discount_code: body.discountCode || null,
    expires_at: expiresAt, paid_at: null, finalized_at: null,
  });
  logStage(orderNumber, "bridge_inserted", {
    bridge_id: bridge.id, total_cents: bridge.total_cents,
  });

  // Fake Stripe session.
  const sessionId = `cs_test_${crypto.randomBytes(8).toString("hex")}`;
  const paymentIntent = `pi_test_${crypto.randomBytes(8).toString("hex")}`;
  bridge.stripe_session_id = sessionId;
  bridge._fake_payment_intent = paymentIntent;     // for webhook fixture
  bridge._fake_amount_total = bridge.total_cents;
  logStage(orderNumber, "stripe_session_ok", { session_id: sessionId, url_present: true });

  return {
    status: 200,
    body: { ok: true, redirect_url: `/__stripe/${sessionId}`, orderNumber },
  };
}

async function handleStripePay(sessionId) {
  // Local fake "Stripe Checkout" page. Renders a completion form that
  // POSTs to /webhook with a properly signed event payload.
  const bridge = db.checkout_bridge_sessions.find((b) => b.stripe_session_id === sessionId);
  if (!bridge) {
    return { status: 404, body: { ok: false, error: "no such session" } };
  }
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><title>Stripe Checkout (FAKE)</title>
  <style>
    body{font-family:Inter,system-ui,sans-serif;background:#f5f3f0;margin:0;padding:48px}
    .panel{max-width:520px;margin:0 auto;background:#fff;padding:32px;border-radius:14px;
           box-shadow:0 2px 24px rgba(0,0,0,.08)}
    h1{font-size:18px;letter-spacing:.1em;text-transform:uppercase;color:#635bff;margin:0 0 8px}
    h2{margin:0 0 24px;font-size:24px}
    .total{font-size:32px;font-weight:700;margin:16px 0}
    button{padding:12px 24px;border:0;border-radius:8px;cursor:pointer;font-weight:600;
           font-size:14px;width:100%}
    .pay{background:#635bff;color:#fff;margin-bottom:8px}
    .cancel{background:#eee;color:#333}
    .order{font-family:'Roboto Mono',monospace;color:#666;font-size:12px;letter-spacing:.05em}
    .stripe-mode{display:inline-block;background:#fff3cd;color:#856404;padding:2px 8px;
                 border-radius:4px;font-size:11px;letter-spacing:.05em;text-transform:uppercase}
  </style></head><body>
  <div class="panel">
    <div><span class="stripe-mode">FAKE — TEST HARNESS</span></div>
    <h1>stripe</h1>
    <h2>HAO YUN LABS Order</h2>
    <div class="order">${bridge.order_number}</div>
    <div class="total">$${bridge.total.toFixed(2)}</div>
    <form method="POST" action="/__stripe-pay/${sessionId}">
      <button class="pay" type="submit">Pay $${bridge.total.toFixed(2)} (4242…)</button>
    </form>
    <form method="POST" action="/__stripe-cancel/${sessionId}">
      <button class="cancel" type="submit">Cancel</button>
    </form>
  </div></body></html>`;
  return { status: 200, headers: { "content-type": "text/html" }, raw: html };
}

async function handleStripeComplete(sessionId, mode) {
  const bridge = db.checkout_bridge_sessions.find((b) => b.stripe_session_id === sessionId);
  if (!bridge) return { status: 404, body: { ok: false, error: "no such session" } };
  if (mode === "cancel") {
    return {
      status: 302,
      headers: { location: `/?payment=cancel&order=${bridge.order_number}` },
      raw: "",
    };
  }
  // Build a real Stripe-style webhook event and call our own webhook
  // endpoint with a valid signature. This mirrors what Stripe does in
  // production after a successful test payment.
  await deliverWebhookForSession(sessionId, {});
  return {
    status: 302,
    headers: {
      location: `/?payment=success&order=${bridge.order_number}&session_id=${sessionId}`,
    },
    raw: "",
  };
}

function signStripePayload(payload, secret = STRIPE_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const h = crypto.createHmac("sha256", secret);
  h.update(`${ts}.${payload}`);
  return `t=${ts},v1=${h.digest("hex")}`;
}

async function deliverWebhookForSession(sessionId, opts = {}) {
  const bridge = db.checkout_bridge_sessions.find((b) => b.stripe_session_id === sessionId);
  if (!bridge) return { status: 404, body: { ok: false, error: "no bridge" } };
  const session = {
    id: sessionId,
    object: "checkout.session",
    client_reference_id: bridge.order_number,
    metadata: { orderNumber: bridge.order_number, bridge_id: bridge.id },
    amount_total: opts.amountTotalCents ?? bridge._fake_amount_total,
    payment_status: opts.paymentStatus ?? "paid",
    payment_intent: bridge._fake_payment_intent,
  };
  const event = {
    id: opts.eventId || `evt_test_${crypto.randomBytes(8).toString("hex")}`,
    object: "event",
    type: opts.eventType ?? "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: { object: session },
  };
  const payload = JSON.stringify(event);
  const sig = opts.badSignature ? "t=1,v1=deadbeef" : signStripePayload(payload);
  return processWebhook(payload, sig);
}

function processWebhook(rawPayload, sigHeader) {
  // Verify signature.
  if (!sigHeader) {
    db.stripe_callbacks.push({
      id: crypto.randomUUID(),
      event_type: "<unknown>", signature_status: "absent",
      outcome: "rejected_signature", outcome_detail: "no Stripe-Signature header",
      created_at: new Date().toISOString(),
    });
    return { status: 401, body: "missing signature" };
  }
  const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]+)$/);
  if (!m) {
    db.stripe_callbacks.push({
      id: crypto.randomUUID(),
      event_type: "<unparseable>", signature_status: "malformed",
      outcome: "rejected_signature", outcome_detail: "bad header format",
      created_at: new Date().toISOString(),
    });
    return { status: 401, body: "bad signature" };
  }
  const expected = signStripePayload(rawPayload, STRIPE_WEBHOOK_SECRET, Number(m[1]));
  if (expected !== sigHeader) {
    db.stripe_callbacks.push({
      id: crypto.randomUUID(),
      event_type: "<mismatch>", signature_status: "mismatch",
      outcome: "rejected_signature", outcome_detail: "HMAC did not verify",
      created_at: new Date().toISOString(),
    });
    return { status: 401, body: "signature mismatch" };
  }

  let event;
  try { event = JSON.parse(rawPayload); }
  catch (_) { return { status: 400, body: "bad json" }; }

  // Idempotency: stripe_event_id unique.
  const existing = db.stripe_callbacks.find((cb) => cb.stripe_event_id === event.id);
  if (existing) {
    return { status: 200, body: { ok: true, idempotent: true } };
  }

  if (event.type !== "checkout.session.completed") {
    db.stripe_callbacks.push({
      id: crypto.randomUUID(), stripe_event_id: event.id, event_type: event.type,
      signature_status: "ok", outcome: "ignored_event_type", raw_payload: event,
      created_at: new Date().toISOString(),
    });
    return { status: 200, body: { ok: true, ignored: event.type } };
  }

  const session = event.data.object;
  const orderNumber = session.client_reference_id || session.metadata?.orderNumber;
  const sessionId = session.id;
  const amountTotalCents = session.amount_total ?? 0;

  const cb = {
    id: crypto.randomUUID(), stripe_event_id: event.id, event_type: event.type,
    order_number: orderNumber, stripe_session_id: sessionId,
    payment_status: session.payment_status, amount_total_cents: amountTotalCents,
    signature_status: "ok", raw_payload: event,
    created_at: new Date().toISOString(),
  };
  db.stripe_callbacks.push(cb);

  logStage(orderNumber, "webhook_received", {
    event_type: event.type, payment_status: session.payment_status,
    amount_total: amountTotalCents,
  });

  const bridge = db.checkout_bridge_sessions.find((b) =>
    b.stripe_session_id === sessionId || b.order_number === orderNumber);
  if (!bridge) {
    cb.outcome = "rejected_no_bridge";
    cb.outcome_detail = "no bridge row matches session_id or order_number";
    logStage(orderNumber, "fail_no_bridge", { session_id: sessionId });
    return { status: 200, body: { ok: true, no_bridge: true } };
  }

  if (bridge.status === "paid") {
    cb.bridge_total_cents = bridge.total_cents;
    cb.outcome = "idempotent";
    cb.outcome_detail = "bridge already paid";
    return { status: 200, body: { ok: true, idempotent: true } };
  }

  if (new Date(bridge.expires_at) < new Date()) {
    bridge.status = "expired";
    bridge.finalized_at = new Date().toISOString();
    cb.bridge_total_cents = bridge.total_cents;
    cb.outcome = "rejected_expired";
    cb.outcome_detail = `expires_at=${bridge.expires_at}`;
    logStage(orderNumber, "fail_expired", { expires_at: bridge.expires_at });
    return { status: 409, body: "bridge expired" };
  }

  if (session.payment_status !== "paid") {
    cb.bridge_total_cents = bridge.total_cents;
    cb.outcome = "ignored_event_type";
    cb.outcome_detail = `payment_status=${session.payment_status}`;
    return { status: 200, body: { ok: true, payment_status: session.payment_status } };
  }

  if (amountTotalCents !== bridge.total_cents) {
    bridge.status = "amount_mismatch";
    bridge.finalized_at = new Date().toISOString();
    cb.bridge_total_cents = bridge.total_cents;
    cb.outcome = "rejected_amount_mismatch";
    cb.outcome_detail = `stripe=${amountTotalCents} bridge=${bridge.total_cents}`;
    logStage(orderNumber, "fail_amount_mismatch",
             { stripe: amountTotalCents, bridge: bridge.total_cents });
    return { status: 409, body: "amount mismatch" };
  }

  // Atomic first-paid-transition.
  const order = db.orders.find((o) => o.order_number === orderNumber);
  let firstPaid = false;
  if (order && !order.paid_at) {
    order.status = "paid";
    order.paid_at = new Date().toISOString();
    order.payment_reference = `stripe:${session.payment_intent}`;
    firstPaid = true;
  }
  bridge.status = "paid";
  bridge.stripe_payment_intent = session.payment_intent;
  bridge.paid_at = new Date().toISOString();
  bridge.finalized_at = new Date().toISOString();

  cb.bridge_total_cents = bridge.total_cents;
  cb.outcome = firstPaid ? "marked_paid" : "idempotent";
  cb.outcome_detail = firstPaid ? null : "orders.paid_at already set";

  if (firstPaid) {
    logStage(orderNumber, "marked_paid", { order_id: order.id });
    const ac = db.abandoned_checkouts.find((a) => a.order_number === orderNumber && !a.recovered);
    if (ac) ac.recovered = true;
  }

  return { status: 200, body: { ok: true } };
}

// ---------------------- HTTP plumbing -------------------------------

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", rej);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS for the test page (it's served from same origin so this is mostly a no-op).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Stripe-Signature");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    // Static files
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await fs.readFile(path.join(__dirname, "index.html"), "utf-8");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      const js = await fs.readFile(path.join(__dirname, "app.js"), "utf-8");
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(js);
      return;
    }

    // The fake Stripe Checkout page
    if (req.method === "GET" && url.pathname.startsWith("/__stripe/")) {
      const sid = url.pathname.slice("/__stripe/".length);
      const r = await handleStripePay(sid);
      res.writeHead(r.status, r.headers || {});
      res.end(r.raw ?? JSON.stringify(r.body));
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/__stripe-pay/")) {
      const sid = url.pathname.slice("/__stripe-pay/".length);
      const r = await handleStripeComplete(sid, "pay");
      res.writeHead(r.status, r.headers || {});
      res.end(r.raw ?? "");
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/__stripe-cancel/")) {
      const sid = url.pathname.slice("/__stripe-cancel/".length);
      const r = await handleStripeComplete(sid, "cancel");
      res.writeHead(r.status, r.headers || {});
      res.end(r.raw ?? "");
      return;
    }

    // POST /functions/v1/stripe-checkout — mirrors the real edge function URL.
    if (req.method === "POST" && url.pathname === "/functions/v1/stripe-checkout") {
      const body = JSON.parse(await readBody(req) || "{}");
      const r = await handleCheckout(body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }

    // POST /functions/v1/stripe-webhook — receives signed events from the fake Stripe.
    if (req.method === "POST" && url.pathname === "/functions/v1/stripe-webhook") {
      const raw = await readBody(req);
      const r = processWebhook(raw, req.headers["stripe-signature"]);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      return;
    }

    // Manual webhook delivery: used by the failure-mode UI buttons.
    if (req.method === "POST" && url.pathname === "/__deliver-webhook") {
      const body = JSON.parse(await readBody(req) || "{}");
      const r = await deliverWebhookForSession(body.sessionId, body.opts || {});
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(typeof r.body === "string"
        ? JSON.stringify({ ok: false, error: r.body }) : JSON.stringify(r.body));
      return;
    }

    // Backdate the bridge for the "expired" demo.
    if (req.method === "POST" && url.pathname === "/__backdate-bridge") {
      const body = JSON.parse(await readBody(req) || "{}");
      const b = db.checkout_bridge_sessions.find((x) => x.order_number === body.orderNumber);
      if (b) b.expires_at = new Date(Date.now() - 60_000).toISOString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, expires_at: b?.expires_at }));
      return;
    }

    // Snapshot the DB for the live UI.
    if (req.method === "GET" && url.pathname === "/__snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        orders: db.orders.slice(-5).reverse(),
        checkout_bridge_sessions: db.checkout_bridge_sessions.slice(-5).reverse(),
        stripe_callbacks: db.stripe_callbacks.slice(-10).reverse(),
        checkout_attempt_log: db.checkout_attempt_log.slice(-30).reverse(),
      }));
      return;
    }

    // Reset.
    if (req.method === "POST" && url.pathname === "/__reset") {
      db.orders = []; db.customers = []; db.order_items = [];
      db.abandoned_checkouts = []; db.checkout_bridge_sessions = [];
      db.stripe_callbacks = []; db.checkout_attempt_log = [];
      logSeq = 1;
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    console.error("server error", e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  HYL Stripe test harness running.`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});
