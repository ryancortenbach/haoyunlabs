// HYL Stripe test harness — frontend.
// Talks to server.mjs on the same origin. No external deps.

let lastOrderNumber = null;
let lastSessionId  = null;

function newOrderNumber() {
  return "HYL-" + Date.now().toString(36).toUpperCase() +
         "-" + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function $(id) { return document.getElementById(id); }

function getOrderBody() {
  const items = [{
    sku: $("sku").value.trim(),
    name: $("sku").value.trim(),
    quantity: Number($("qty").value),
    unitPrice: Number($("unitPrice").value),
    lineTotal: Number($("qty").value) * Number($("unitPrice").value),
  }];
  const subtotal = items[0].lineTotal;
  const code = $("codePicker").value;
  const discreet = $("discreet").checked;
  return {
    orderNumber: $("orderNumber").value || newOrderNumber(),
    email: $("email").value, fname: $("fname").value, lname: $("lname").value,
    phone: $("phone").value, street: $("street").value, apt: "",
    city: $("city").value, state: $("state").value, zip: $("zip").value,
    items, subtotal, shipping: 12, processingFee: 0,
    discountCode: code || null, discountAmount: 0, affiliateCode: null,
    discreetPackaging: discreet,
  };
}

// Local recompute mirroring the server. Just for the proposed-total display.
function recalc() {
  const subtotal = Number($("qty").value) * Number($("unitPrice").value);
  let discount = 0;
  const code = $("codePicker").value;
  const codeMap = { PENNY: 99.99, ZARA20: 20, SAVE10: 10 };
  if (codeMap[code] != null) {
    discount = Math.round(subtotal * codeMap[code]) / 100;
  }
  const discreet = $("discreet").checked ? 5 : 0;
  const total = Math.round((subtotal - discount + 12 + discreet) * 100) / 100;
  $("proposedTotal").textContent = total.toFixed(2);
  return total;
}

function tamper() {
  const cur = Number($("proposedTotal").textContent);
  $("proposedTotal").textContent = (cur - 50).toFixed(2);
}

async function submitOrder() {
  if (!$("orderNumber").value) $("orderNumber").value = newOrderNumber();
  const body = getOrderBody();
  body.amount = Number($("proposedTotal").textContent);
  const r = await fetch("/functions/v1/stripe-checkout", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  $("lastResp").textContent = "POST /stripe-checkout → " + r.status + "\n" + JSON.stringify(j, null, 2);
  if (j.ok && j.redirect_url) {
    lastOrderNumber = body.orderNumber;
    lastSessionId   = j.redirect_url.split("/").pop();
    refresh();
    // Open the fake Stripe page in a new tab so the original stays focused
    // on the live data view.
    window.open(j.redirect_url, "stripe-fake");
  } else {
    refresh();
  }
}

async function postJson(path, body) {
  const r = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  $("lastResp").textContent = `POST ${path} → ${r.status}\n` + JSON.stringify(j, null, 2);
  refresh();
}

function ensureSession() {
  if (!lastSessionId) {
    alert("Submit the order form first so a bridge + Stripe session exists.");
    return false;
  }
  return true;
}

function failureBadSig() {
  if (!ensureSession()) return;
  postJson("/__deliver-webhook", { sessionId: lastSessionId, opts: { badSignature: true } });
}
function failureAmount() {
  if (!ensureSession()) return;
  postJson("/__deliver-webhook", { sessionId: lastSessionId, opts: { amountTotalCents: 50000 } });
}
async function failureExpired() {
  if (!lastOrderNumber) { alert("Submit first."); return; }
  await postJson("/__backdate-bridge", { orderNumber: lastOrderNumber });
  await postJson("/__deliver-webhook", { sessionId: lastSessionId, opts: {} });
}
async function failureReplay() {
  if (!ensureSession()) return;
  const fixedId = "evt_test_replay_fixed";
  await postJson("/__deliver-webhook", { sessionId: lastSessionId, opts: { eventId: fixedId } });
  await postJson("/__deliver-webhook", { sessionId: lastSessionId, opts: { eventId: fixedId } });
}
function failureWrongEvent() {
  if (!ensureSession()) return;
  postJson("/__deliver-webhook",
    { sessionId: lastSessionId, opts: { eventType: "payment_intent.succeeded" } });
}
async function resetAll() {
  await postJson("/__reset", {});
  $("orderNumber").value = "";
  lastOrderNumber = null; lastSessionId = null;
  recalc();
}

function pill(value, kind = "") {
  if (value == null) return "";
  const cls = "pill pill-" + String(value).replace(/\s/g, "_");
  return `<span class="${cls}">${value}</span>`;
}

function bridgeRow(b) {
  return `<tr>
    <td>${b.order_number}</td>
    <td>${pill(b.status)}</td>
    <td>$${Number(b.total).toFixed(2)}<br><span style="color:#888">(${b.total_cents}¢)</span></td>
    <td>${b.stripe_session_id || "<i style='color:#aaa'>—</i>"}</td>
    <td>${b.expires_at ? new Date(b.expires_at).toLocaleTimeString() : ""}</td>
  </tr>`;
}

function orderRow(o) {
  return `<tr>
    <td>${o.order_number}</td>
    <td>${pill(o.status)}</td>
    <td>$${Number(o.total).toFixed(2)}</td>
    <td>${o.payment_method || ""}</td>
    <td>${o.payment_reference || "<i style='color:#aaa'>—</i>"}</td>
  </tr>`;
}

function callbackRow(cb) {
  return `<tr>
    <td>${cb.event_type}</td>
    <td>${pill(cb.signature_status)}</td>
    <td>${pill(cb.outcome || "—")}</td>
    <td>${cb.amount_total_cents ?? ""}<br><span style="color:#888">vs ${cb.bridge_total_cents ?? ""}</span></td>
    <td style="color:#a00">${cb.outcome_detail || ""}</td>
  </tr>`;
}

function logRow(l) {
  return `<tr>
    <td>${new Date(l.created_at).toLocaleTimeString()}</td>
    <td>${l.order_number}</td>
    <td class="stage-${l.stage}">${l.stage}</td>
    <td>${l.detail ? `<pre style="margin:0;background:transparent;padding:0">${JSON.stringify(l.detail)}</pre>` : ""}</td>
  </tr>`;
}

function table(headers, rows, fn) {
  if (!rows.length) return `<div style="color:#999;font-size:11px">no rows</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(fn).join("")}</tbody></table>`;
}

async function refresh() {
  const r = await fetch("/__snapshot");
  const s = await r.json();
  $("bridgesTable").innerHTML = table(
    ["order_number", "status", "total", "stripe_session_id", "expires_at"],
    s.checkout_bridge_sessions, bridgeRow);
  $("ordersTable").innerHTML = table(
    ["order_number", "status", "total", "payment_method", "payment_reference"],
    s.orders, orderRow);
  $("callbacksTable").innerHTML = table(
    ["event_type", "signature", "outcome", "amount", "detail"],
    s.stripe_callbacks, callbackRow);
  $("attemptTable").innerHTML = table(
    ["time", "order", "stage", "detail"],
    s.checkout_attempt_log, logRow);
}

setInterval(refresh, 1500);
recalc();
refresh();
