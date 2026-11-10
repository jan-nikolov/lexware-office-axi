---
name: lexware-office-axi
description: Use for anything in Lexware Office (formerly lexoffice) – invoices, quotations, credit notes, dunnings, receipts/vouchers, uploads, contacts, payments, overdue invoices, bookkeeping. Rechnung, Angebot, Gutschrift, Mahnung, Beleg, Buchhaltung.
---

# lexware-office-axi

Agent CLI for the complete Lexware Office public API. Output is TOON (compact, structured). Run `lexware-office-axi` (or `npx -y lexware-office-axi`) with no arguments for a live overview, `lexware-office-axi <command> --help` and `lexware-office-axi <command> <verb> --help` for flags, minimal JSON bodies and examples.

## Rules

- **Tiers.** `read` is free. `write` (drafts, uploads, contacts) is free; add `--dry-run` to see the exact request first. `final` (finalize, book, delete, webhooks, raw writes) only previews unless you add `--confirm`.
- **Never add `--confirm` on your own.** Show the preview, get the user's explicit go for that exact action, then re-run with `--confirm`.
- Sales documents are created as drafts, vouchers as unchecked (Zu prüfen). Drafts, vouchers, contacts and uploads cannot be deleted through the API – only in the Lexware web app – so don't create them speculatively.
- Existing drafts cannot be finalized via the API; `create --finalize --confirm` issues a new numbered document.
- Errors come with a `code` and `help`; follow the help. On `WRITE_OUTCOME_UNKNOWN` check with `list`/`get` before retrying, never resend blindly.
- Keys: `LEXWARE_API_KEY` (or `LEXOFFICE_API_KEY`); named profiles via `--profile <name>` and `LEXWARE_API_KEY_<NAME>`. Never print or ask for keys in chat.

## Common tasks

- Overdue invoices: `lexware-office-axi invoices list --status overdue`
- Upload a receipt and see what Lexware read: `lexware-office-axi vouchers upload <file> --wait`; book it: `lexware-office-axi vouchers book <id> --body '{...}'` (preview) → `--confirm` after approval
- Posting category ids for voucher items: `lexware-office-axi ref posting-categories --type outgo --search <text>`
- Invoice draft: `lexware-office-axi invoices create --body-file inv.json` (see `invoices create --help` for a minimal body)
- Download a document: `lexware-office-axi invoices file <id> --out <dir>`
- Payment status: `lexware-office-axi payments get <id>`
- Anything else: `lexware-office-axi raw GET /v1/<path>`

## Commands

### invoices – Rechnungen

- `lexware-office-axi invoices list [--status open|overdue|...] [--date-from YYYY-MM-DD] [--contact <id>]` – read
- `lexware-office-axi invoices get <id> [--full]` – read
- `lexware-office-axi invoices create --body-file invoices.json [--finalize --confirm]` – depends
- `lexware-office-axi invoices file <id> [--out <file|dir>] [--format pdf|xml|auto]` – read
- `lexware-office-axi invoices render <id>` – read

### credit-notes – Gutschriften / Rechnungskorrekturen

- `lexware-office-axi credit-notes list [--status open|overdue|...] [--date-from YYYY-MM-DD] [--contact <id>]` – read
- `lexware-office-axi credit-notes get <id> [--full]` – read
- `lexware-office-axi credit-notes create --body-file credit-notes.json [--finalize --confirm]` – depends
- `lexware-office-axi credit-notes file <id> [--out <file|dir>] [--format pdf|xml|auto]` – read
- `lexware-office-axi credit-notes render <id>` – read

### quotations – Angebote

- `lexware-office-axi quotations list [--status open|overdue|...] [--date-from YYYY-MM-DD] [--contact <id>]` – read
- `lexware-office-axi quotations get <id> [--full]` – read
- `lexware-office-axi quotations create --body-file quotations.json [--finalize --confirm]` – depends
- `lexware-office-axi quotations file <id> [--out <file|dir>] [--format pdf|xml|auto]` – read
- `lexware-office-axi quotations render <id>` – read

### order-confirmations – Auftragsbestätigungen

- `lexware-office-axi order-confirmations list [--status open|overdue|...] [--date-from YYYY-MM-DD] [--contact <id>]` – read
- `lexware-office-axi order-confirmations get <id> [--full]` – read
- `lexware-office-axi order-confirmations create --body-file order-confirmations.json [--finalize --confirm]` – depends
- `lexware-office-axi order-confirmations file <id> [--out <file|dir>] [--format pdf|xml|auto]` – read
- `lexware-office-axi order-confirmations render <id>` – read

### delivery-notes – Lieferscheine

- `lexware-office-axi delivery-notes list [--status open|overdue|...] [--date-from YYYY-MM-DD] [--contact <id>]` – read
- `lexware-office-axi delivery-notes get <id> [--full]` – read
- `lexware-office-axi delivery-notes create --body-file delivery-notes.json [--finalize --confirm]` – depends
- `lexware-office-axi delivery-notes file <id> [--out <file|dir>] [--format pdf|xml|auto]` – read
- `lexware-office-axi delivery-notes render <id>` – read

### dunnings – Mahnungen

- `lexware-office-axi dunnings get <id> [--full]` – read
- `lexware-office-axi dunnings create --body-file dunnings.json --from <invoice-id>` – write
- `lexware-office-axi dunnings file <id> [--out <file|dir>] [--format pdf|xml|auto]` – read
- `lexware-office-axi dunnings render <id>` – read

### down-payment-invoices – Abschlagsrechnungen

- `lexware-office-axi down-payment-invoices list [--status open|overdue|...] [--date-from YYYY-MM-DD] [--contact <id>]` – read
- `lexware-office-axi down-payment-invoices get <id> [--full]` – read
- `lexware-office-axi down-payment-invoices file <id> [--out <file|dir>] [--format pdf|xml|auto]` – read

### vouchers – Belege / Buchhaltung

- `lexware-office-axi vouchers list [--type purchaseinvoice] [--status unchecked|open|...] [--date-from YYYY-MM-DD]` – read
- `lexware-office-axi vouchers get <id> [--full]` – read
- `lexware-office-axi vouchers upload <file> [--wait]` – write
- `lexware-office-axi vouchers attach <voucher-id> <file>` – write
- `lexware-office-axi vouchers create --body-file voucher.json [--book --confirm]` – depends
- `lexware-office-axi vouchers update <id> --body '{...}' [--replace] [--confirm]` – depends
- `lexware-office-axi vouchers book <id> [--body '{"voucherItems":[...]}'] --confirm` – final
- `lexware-office-axi vouchers file <voucher-id> [--index N] [--out <file|dir>]` – read

### contacts – Kontakte / Kunden / Lieferanten

- `lexware-office-axi contacts list [--name <text>] [--email <text>] [--number N] [--customer] [--vendor]` – read
- `lexware-office-axi contacts get <id> [--full]` – read
- `lexware-office-axi contacts create --body-file contact.json` – write
- `lexware-office-axi contacts update <id> --body '{...}' [--replace]` – write

### articles – Artikel

- `lexware-office-axi articles list [--number <articleNumber>] [--gtin <gtin>] [--type PRODUCT|SERVICE]` – read
- `lexware-office-axi articles get <id> [--full]` – read
- `lexware-office-axi articles create --body-file article.json` – write
- `lexware-office-axi articles update <id> --body '{...}' [--replace]` – write
- `lexware-office-axi articles delete <id> --confirm` – final

### payments – Zahlungen

- `lexware-office-axi payments get <voucher-or-invoice-id>` – read

### recurring-templates – Wiederkehrende Rechnungen

- `lexware-office-axi recurring-templates list [--sort nextExecutionDate,ASC]` – read
- `lexware-office-axi recurring-templates get <id> [--full]` – read

### webhooks – Webhooks / Event-Abos

- `lexware-office-axi webhooks list` – read
- `lexware-office-axi webhooks get <id>` – read
- `lexware-office-axi webhooks create --event <type> --url https://… --confirm` – final
- `lexware-office-axi webhooks delete <id> --confirm` – final

### ref – Stammdaten

- `lexware-office-axi ref countries` – read
- `lexware-office-axi ref posting-categories [--type income|outgo] [--search <text>]` – read
- `lexware-office-axi ref payment-conditions` – read
- `lexware-office-axi ref print-layouts` – read

### files – Dateien

- `lexware-office-axi files get <file-id> [--out <file|dir>] [--format auto|pdf|xml|png|jpg]` – read
- `lexware-office-axi files upload <file>` – write

### raw

- `lexware-office-axi raw GET /v1/<path> [--query key=value]... [--accept <type> --out <file>]` – read
- `lexware-office-axi raw POST /v1/<path> [--body '{...}'] [--query key=value]... --confirm` – final
- `lexware-office-axi raw PUT /v1/<path> [--body '{...}'] [--query key=value]... --confirm` – final
- `lexware-office-axi raw DELETE /v1/<path> [--body '{...}'] [--query key=value]... --confirm` – final

### auth

- `lexware-office-axi auth status [--live]` – read
- `lexware-office-axi auth set [--profile <name>] [--no-check] < keyfile` – write
- `lexware-office-axi auth remove [--profile <name>]` – write
