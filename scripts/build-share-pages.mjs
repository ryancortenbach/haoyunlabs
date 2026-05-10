#!/usr/bin/env node
// Generates share/<SKU>.html for every product. Each page sets product-specific
// OpenGraph + Twitter card meta tags so link previews on Slack/Twitter/iMessage/etc.
// show the actual product image. A meta-refresh + JS redirect sends humans to the
// real PDP at /index.html#product/<SKU>.
//
// Run: node scripts/build-share-pages.mjs
// Re-run after editing CATALOG_* arrays in index.html.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_ROOT = path.resolve(__dirname, '..')
const INDEX_HTML = path.join(SITE_ROOT, 'index.html')
const SHARE_DIR = path.join(SITE_ROOT, 'share')
const PRODUCT_IMG_DIR = path.join(SITE_ROOT, 'media', 'products')
const BUNDLE_IMG_DIR = path.join(SITE_ROOT, 'media', 'bundles')
const ORIGIN = 'https://haoyunlabs.com'
const FALLBACK_OG = `${ORIGIN}/og.jpg?v=2`

const html = fs.readFileSync(INDEX_HTML, 'utf8')

function extractArray(name) {
  const start = html.indexOf(`const ${name} = [`)
  if (start === -1) throw new Error(`Could not find ${name}`)
  let depth = 0
  let i = html.indexOf('[', start)
  const open = i
  for (; i < html.length; i++) {
    if (html[i] === '[') depth++
    else if (html[i] === ']') { depth--; if (depth === 0) { break } }
  }
  const body = html.slice(open + 1, i)
  const rowRe = /\{\s*sku\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"]\s*,\s*price\s*:\s*([0-9.]+)/g
  const out = []
  let m
  while ((m = rowRe.exec(body)) !== null) out.push({ sku: m[1], name: m[2], price: parseFloat(m[3]) })
  return out
}

const individual = extractArray('CATALOG_INDIVIDUAL')
const kits = extractArray('CATALOG_KITS')
const bundles = extractArray('CATALOG_BUNDLES')
const supplies = extractArray('CATALOG_SUPPLIES')

const all = [
  ...individual.map((p) => ({ ...p, kind: 'individual' })),
  ...kits.map((p) => ({ ...p, kind: 'kit' })),
  ...bundles.map((p) => ({ ...p, kind: 'bundle' })),
  ...supplies.map((p) => ({ ...p, kind: 'supply' })),
]

function pickImage(p) {
  if (p.kind === 'bundle') {
    const f = path.join(BUNDLE_IMG_DIR, `${p.sku}.png`)
    if (fs.existsSync(f)) return `${ORIGIN}/media/bundles/${p.sku}.png`
  }
  const lower = p.sku.toLowerCase()
  const candidates = [`${p.sku}.png`, `${lower}.png`]
  for (const c of candidates) {
    if (fs.existsSync(path.join(PRODUCT_IMG_DIR, c))) return `${ORIGIN}/media/products/${c}`
  }
  return FALLBACK_OG
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function pageFor(p) {
  const img = pickImage(p)
  const titleRaw = `${p.name} | Hao Yun Labs`
  const title = escapeHtml(titleRaw)
  const desc = escapeHtml(`HPLC-verified ${p.name} from Hao Yun Labs. Lot-tested research peptide. $${p.price.toFixed(2)}.`)
  const pdpUrl = `${ORIGIN}/index.html#product/${encodeURIComponent(p.sku)}`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${pdpUrl}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Hao Yun Labs">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="1200">
<meta property="og:url" content="${ORIGIN}/share/${encodeURIComponent(p.sku)}.html">
<meta property="product:price:amount" content="${p.price.toFixed(2)}">
<meta property="product:price:currency" content="USD">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0;url=${pdpUrl}">
<script>window.location.replace(${JSON.stringify(pdpUrl)});</script>
<style>body{font-family:-apple-system,sans-serif;text-align:center;padding:48px 20px;color:#111}a{color:#000}</style>
</head>
<body>
<p>Redirecting to <a href="${pdpUrl}">${title}</a>&hellip;</p>
</body>
</html>
`
}

if (!fs.existsSync(SHARE_DIR)) fs.mkdirSync(SHARE_DIR, { recursive: true })

let written = 0
let skipped = 0
const seen = new Set()
for (const p of all) {
  if (seen.has(p.sku)) { skipped++; continue }
  seen.add(p.sku)
  fs.writeFileSync(path.join(SHARE_DIR, `${p.sku}.html`), pageFor(p))
  written++
}

console.log(`wrote ${written} share pages (skipped ${skipped} duplicates) into ${SHARE_DIR}`)
