# Changelog

## 0.1.2 – 2026-11-10

- Previews of binding actions (book, create --book, voucher update that books, sales create --finalize) carry `about`: one readable line with contact, number, amount, date, tax and posting category, so approval UIs can show what is affected instead of the raw request. The lookups run only for previews, not with --confirm.

## 0.1.1 – 2026-11-10

- First release published from GitHub Actions via npm Trusted Publishing, with provenance.
- `bin` path written the way npm normalizes it (no publish warning).

## 0.1.0 – 2026-11-10

- First release: complete Lexware Office public API (sales documents, vouchers, upload, contacts, articles, payments, recurring templates, webhooks, reference data, raw), home overview, TOON output, safety tiers with `--dry-run` and `--confirm`, profiles, generated agent skill.
