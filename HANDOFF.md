# Hao Yun Labs Site — Handoff Notes

Working dir: `/Users/ryancortenbach/HaoYunLabs/site`
Main file: `index.html` (single-page app, ~9500 lines)
Repo: git, branch `main`

## Outstanding Work

### #27 — BAC water vial images (blocked on rendered PNGs)
- SKUs: `BAC3SV`, `BAC10SV`
- Current files at `media/products/BAC3SV.png` and `media/products/BAC10SV.png` are **all the same placeholder** (md5 `41d14895d644c495eb47842a893c914e`) showing the old "A Research Company" black-label design.
- New label spec is in `/tmp/3_(Bulk 3) Your paragraph text.txt` (see lines 43–54: "Hao Yun Labs / Bac Water / 3ml / Purity >99% / For Research Use Only.")
- **To complete:** generate distinct new-style PNGs (matching the new vial design used by `RT10SV.png`, `SM5SV.png`, etc. — ~330KB, May 2 dated), then **remove `BAC3SV` and `BAC10SV` from the `OLD_IMAGE_SKUS` Set in `index.html` line 4712**.

### #28 — Acetic acid vial images — DONE (commit 3f23499)
- `ACET06-10ML.png` and `ACET1-10ML.png` now use the new-style renders (copied from `AA06SV.png`/`AA1SV.png`).
- Both SKUs removed from `OLD_IMAGE_SKUS`.

## Image Pipeline Reference

`getProductImageHTML(p)` at `index.html:4713`:
1. Bundles → `media/bundles/${sku}.png`
2. Kits in `KIT_SKUS_WITH_IMAGES` and not in `OLD_IMAGE_SKUS` → `media/kits/${sku}.png`
3. SKUs in `VALID_SKUS` and not in `OLD_IMAGE_SKUS` → `media/products/${sku}.png`
4. Fallback → black box with text overlay

`OLD_IMAGE_SKUS` (line 4712) is the gate that suppresses old "A Research Company" black-label renders. The list (182 SKUs) was verified against disk: matches all 184 PNGs that are <200KB and dated Apr 12 (the old batch). New PNGs are >200KB, dated May 2.

To verify:
```bash
find media/products/ -name "*.png" -size -200k -newermt "2026-04-01" -not -newermt "2026-04-30" -exec basename {} .png \; | sort
```

## What Just Shipped

- **PDP brand top-right** — `pdp-back-row` (line 2739) now has "Hao Yun Labs" on the right.
- **Kits PDP COA** — `openProduct()` at line 6464 now falls back to `compound + dose` lookup in `COA_DATA` for kits (kit names are `"Compound (Dose x 10 vials)"`, COA entries are `"Compound Dose"`).
- **Shop The Kits CTA** — line 2614 now `setProductType('kits');goToCategory('growth-recovery')`.
- **Add to cart green flash** — new `pdpAddBtnFlash()` at line 6595 swaps bg to `#16a34a` and text to "Added" for 1.1s. Button at line 6530.
- **Card "More Details" slide-right** — line 6143 now uses `<span class="pdp-more-arrow">→</span>`. CSS `.card-details` at line 811 uses `grid-template-rows` transition for smooth open/close. `toggleDetails()` at line 6187 toggles `is-open` on the arrow.
- **PDP slider sizing** — chevrons 36→28px, SVGs 14→11px, dots 14×9→10×6px (line 6498).
- **Co-buy recommendations** — new `_coBuyMap` at line 6451 keyed by lowercased compound name. Heading changed to "Frequently Stacked With" (line 6592). Falls back to same-category, then bestsellers.
- **COA black bug** — confirmed fixed: `renderCoaCanvas()` at line 6560 paints PDF.js to canvas with explicit `#fff` fill (no Chrome dark-mode PDF viewer).

## Test Setup

Local dev: `python3 -m http.server 8765` from site root, then `http://localhost:8765/index.html`.

Playwright MCP works for screenshots; key calls:
- `openProduct('SKU')` to jump to PDP
- `document.querySelector('.pdp-add-btn').click()` to test cart flash
- `document.querySelectorAll('.pdp-slide').length` to check slider count

## Key Data Structures

- `VALID_SKUS` (line 4641) — Set of all sellable SKUs
- `OLD_IMAGE_SKUS` (line 4712) — Set of SKUs gated to text fallback
- `KIT_SKUS_WITH_IMAGES` (line 4709) — Set of kit SKUs with renders in `media/kits/`
- `CATALOG_SUPPLIES` (line 4486) — BAC/ACET/needles/swabs definitions
- `COA_DATA` — global from `coa/` archive, entries `{p:"Name Dose", c:"FILECODE", pu:"99.x%", _skus:[...]}`
- `COA_BASE` (line 3968) — Supabase storage URL for `${code}.pdf`

## Conventions

- No emojis in code or commits.
- No Co-Authored-By trailers in commits.
- Single-file edits to `index.html`; CSS lives in `<style>` blocks at top.
