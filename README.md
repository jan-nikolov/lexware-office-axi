# lexware-office-axi

**Lexware Office (ehemals lexoffice) als CLI für KI-Agenten** – die komplette öffentliche Lexware-API für Claude Code, Codex, ChatGPT, Cursor, Hermes und jeden anderen Agenten, der Shell-Befehle ausführen kann. Gebaut nach dem [AXI-Standard](https://axi.md/): kompakte [TOON](https://toonformat.dev/)-Ausgabe statt JSON-Wüste, klare Fehler mit Lösungsvorschlag und ein Sicherheitsmodell, das Festschreiben und Buchen nie „aus Versehen“ passieren lässt.

[![npm](https://img.shields.io/npm/v/lexware-office-axi)](https://www.npmjs.com/package/lexware-office-axi)
[![CI](https://github.com/jan-nikolov/lexware-office-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/jan-nikolov/lexware-office-axi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![AXI](https://img.shields.io/badge/built%20with-AXI-blue)](https://axi.md/)

> **In English:** `lexware-office-axi` is an agent-ergonomic CLI for the complete [Lexware Office](https://www.lexware.de/lexware-office/) (formerly lexoffice) public API – invoices, quotations, credit notes, dunnings, bookkeeping vouchers, receipt upload, contacts, articles, payments, webhooks. Token-efficient TOON output, structured errors, built on the [AXI](https://axi.md/) principles. Binding actions (finalize, book, delete) only run with `--confirm`; everything else previews first. `npx -y lexware-office-axi --help` to start.

> **Inoffizielles Community-Projekt.** Nicht von der Haufe-Lexware GmbH & Co. KG und nicht mit ihr verbunden. „Lexware“ und „lexoffice“ sind Marken der Haufe Group und werden hier nur beschreibend verwendet.

## Was es kann

- **Alles aus der API:** Rechnungen, Angebote, Auftragsbestätigungen, Lieferscheine, Gutschriften, Mahnungen, Abschlagsrechnungen, wiederkehrende Vorlagen, Belege (Buchhaltung), Beleg-Upload mit Texterkennung, Kontakte, Artikel, Zahlungen, Webhooks, Stammdaten – plus `raw` für jeden Endpunkt.
- **Übersicht auf einen Blick:** `lexware-office-axi` ohne Argumente zeigt überfällige und offene Rechnungen und Belege „zu prüfen“.
- **Für Agenten gebaut:** kompakte Ausgabe (≈40 % weniger Tokens als JSON), Summen schon berechnet, eindeutige Leer-Ergebnisse, Folgebefehle nach jeder Ausgabe, Fehler mit `code` und `help`, Exit-Codes 0/1/2.
- **Sicher:** Belege landen immer in „Zu prüfen“, Verkaufsbelege immer als Entwurf. Festschreiben, Buchen, Löschen und Webhooks zeigen ohne `--confirm` nur eine Vorschau. Schreibvorgänge werden nach einem Timeout nie blind wiederholt (keine Doppelrechnungen).
- **Robust:** hält das Limit von 2 Anfragen/Sekunde selbst ein, wiederholt Lesezugriffe bei Störungen, PDFs und XRechnung-XML werden mit Lexwares Dateinamen gespeichert.
- **Klein:** zwei Laufzeitabhängigkeiten, kein Hintergrundprozess, kein MCP-Server, der dauerhaft RAM belegt.

## Installation

```bash
npx -y lexware-office-axi --help
```

Oder dauerhaft:

```bash
npm install -g lexware-office-axi
```

Node.js ≥ 22. Den Agenten-Skill (für Claude Code, Codex und andere) gibt es mit:

```bash
npx skills add jan-nikolov/lexware-office-axi --skill lexware-office-axi
```

## API-Schlüssel

Schlüssel unter <https://app.lexware.de/addons/public-api> anlegen, dann eins von beiden:

```bash
export LEXWARE_API_KEY=…            # oder LEXOFFICE_API_KEY
```

```bash
pbpaste | lexware-office-axi auth set   # prüft den Schlüssel und speichert ihn mit Dateirechten 0600
```

Mehrere Konten (z. B. ein kostenloses [Testkonto](https://app.lexware.de/signup/app/trial)) über Profile: `--profile test` liest `LEXWARE_API_KEY_TEST` oder den mit `auth set --profile test` gespeicherten Schlüssel. `lexware-office-axi auth status --live` zeigt, welcher Schlüssel woher kommt und ob er funktioniert. Schlüssel erscheinen nie in Ausgaben oder Fehlermeldungen.

## Schnellstart

```bash
lexware-office-axi                                   # Übersicht
lexware-office-axi invoices list --status overdue    # überfällige Rechnungen
lexware-office-axi invoices get <id>                 # Details mit Positionen und Link
lexware-office-axi invoices file <id> --out ./pdf/   # PDF laden
lexware-office-axi payments get <id>                 # offener Betrag, Zahlungen
lexware-office-axi vouchers upload rechnung.pdf --wait   # Beleg hochladen, Erkanntes anzeigen
lexware-office-axi vouchers book <id> --body '{…}'   # Vorschau der Buchung
lexware-office-axi vouchers book <id> --body '{…}' --confirm
lexware-office-axi ref posting-categories --type outgo --search reise
lexware-office-axi invoices create --body-file rechnung.json         # Entwurf
lexware-office-axi invoices create --body-file rechnung.json --finalize --confirm
```

Jeder Befehl erklärt sich selbst: `lexware-office-axi invoices --help`, `lexware-office-axi invoices create --help` (mit minimalem JSON-Body).

Beispielausgabe:

```text
count: 2
invoices[2]{id,number,status,date,due,contact,total,open}:
  55125cc1-…,RE0002,open,2026-11-10,2026-11-10,AXI Testkunde GmbH,214.2,107.1
  7e255278-…,RE0001,draft,2026-11-10,null,AXI Testkunde GmbH,214.2,null
sum_shown:
  total: 428.4
  open: 107.1
help[1]: Run `lexware-office-axi invoices get <id>` for details
```

## Befehle

| Befehl | Inhalt |
|---|---|
| `invoices`, `credit-notes`, `quotations`, `order-confirmations`, `delivery-notes` | `list`, `get`, `create` (Entwurf, Folgebeleg mit `--from`, `--finalize --confirm`), `file`, `render` |
| `dunnings` | Mahnung zu einer Rechnung anlegen (`--from`), `get`, `file` |
| `down-payment-invoices` | `list`, `get`, `file` (API ist hier nur lesend) |
| `vouchers` | `list`, `get`, `upload`, `attach`, `create`, `update`, `book`, `file` |
| `contacts`, `articles` | `list`, `get`, `create`, `update` (Felder werden in den aktuellen Stand eingemischt, `version` automatisch); Artikel auch `delete` |
| `payments` | Zahlungsstatus eines Belegs |
| `recurring-templates` | wiederkehrende Rechnungen: `list`, `get` |
| `webhooks` | Event-Abos: `list`, `get`, `create`, `delete` |
| `ref` | `countries`, `posting-categories`, `payment-conditions`, `print-layouts` |
| `files` | gespeicherte Dateien laden, `upload` |
| `profile`, `auth`, `raw` | Organisation, Schlüssel, direkter API-Zugriff |

## Sicherheitsmodell

| Stufe | Beispiele | Verhalten |
|---|---|---|
| `read` | `list`, `get`, `file` | läuft sofort |
| `write` | Entwürfe, Upload, Kontakte, Artikel | läuft sofort; `--dry-run` zeigt die exakte Anfrage |
| `final` | `--finalize`, `book`, `--book`, `delete`, `webhooks create`, `raw POST/PUT/DELETE` | ohne `--confirm` nur Vorschau, Exit 0 |

So kann ein Agent frei recherchieren und vorbereiten, und das bindende Kommando ist ein eigener, gut sichtbarer Schritt – ideal für eine Freigabe durch einen Menschen, z. B. als Button in Slack oder als Tool-Bestätigung.

## Was die Lexware-API nicht kann (gut zu wissen)

Live geprüft, Stand November 2026:

- Entwürfe, Belege, Kontakte und hochgeladene Dateien lassen sich per API **nicht löschen**, nur in der Web-App.
- Ein bestehender Entwurf lässt sich per API **nicht festschreiben**; `create --finalize` erzeugt einen neuen Beleg mit neuer Nummer. Entwürfe bekommen bereits eine Nummer.
- Ein Beleg ohne Statusangabe wird von Lexware **sofort gebucht** – diese CLI legt deshalb immer `unchecked` an.
- Eine finalisierte Gutschrift mit `--from <Rechnung>` reduziert den offenen Betrag der Rechnung sofort.
- Beim Upload derselben Datei gibt Lexware den vorhandenen Beleg zurück.
- `/v1/files/{id}/status` wird in der Doku erwähnt, antwortet aber mit 403.
- Limit: 2 Anfragen/Sekunde für alle Endpunkte, höchstens 10.000 Treffer pro Suche.

## Mit Agenten nutzen

- **Claude Code / Codex / Cursor:** Skill installieren (siehe oben) oder in `AGENTS.md`/`CLAUDE.md` schreiben: „Für Lexware Office `lexware-office-axi` verwenden.“
- **ChatGPT, Hermes und andere:** jede Umgebung mit Shell-Zugriff; der Agent startet mit `lexware-office-axi --help`.
- **Freigaben:** Lass deinen Agenten-Harness Befehle mit `--confirm` abfangen und vom Menschen bestätigen. Der Skill weist Agenten an, `--confirm` nie eigenmächtig zu setzen.

## Entwicklung

```bash
npm install
npm run build
npm test                 # Tests gegen eine Fake-API, ohne Netz
npm run check:skill      # Skill ist aus den Befehlen erzeugt und aktuell
```

Live-Tests nur gegen ein Testkonto, z. B. `LEXWARE_API_KEY_TEST=… node dist/bin/lexware-office-axi.js --profile test …`. Beiträge willkommen; Pflege ohne Zusagen.

## Lizenz

MIT © Jan Nikolov
