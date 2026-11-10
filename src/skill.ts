import type { Resource } from "./core.js";
import { BIN } from "./core.js";

/**
 * Generates the agent skill from the same command registry as `--help`, so the two never drift.
 * No live state, no secrets.
 */
export function renderSkill(resources: Resource[]): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${BIN}`);
  lines.push(
    "description: Use for anything in Lexware Office (formerly lexoffice) – invoices, quotations, credit notes, dunnings, receipts/vouchers, uploads, contacts, payments, overdue invoices, bookkeeping. Rechnung, Angebot, Gutschrift, Mahnung, Beleg, Buchhaltung.",
  );
  lines.push("---");
  lines.push("");
  lines.push(`# ${BIN}`);
  lines.push("");
  lines.push(
    `Agent CLI for the complete Lexware Office public API. Output is TOON (compact, structured). Run \`${BIN}\` (or \`npx -y ${BIN}\`) with no arguments for a live overview, \`${BIN} <command> --help\` and \`${BIN} <command> <verb> --help\` for flags, minimal JSON bodies and examples.`,
  );
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- **Tiers.** `read` is free. `write` (drafts, uploads, contacts) is free; add `--dry-run` to see the exact request first. `final` (finalize, book, delete, webhooks, raw writes) only previews unless you add `--confirm`.");
  lines.push("- **Never add `--confirm` on your own.** Show the preview, get the user's explicit go for that exact action, then re-run with `--confirm`.");
  lines.push("- Sales documents are created as drafts, vouchers as unchecked (Zu prüfen). Drafts, vouchers, contacts and uploads cannot be deleted through the API – only in the Lexware web app – so don't create them speculatively.");
  lines.push("- Existing drafts cannot be finalized via the API; `create --finalize --confirm` issues a new numbered document.");
  lines.push("- Errors come with a `code` and `help`; follow the help. On `WRITE_OUTCOME_UNKNOWN` check with `list`/`get` before retrying, never resend blindly.");
  lines.push("- Keys: `LEXWARE_API_KEY` (or `LEXOFFICE_API_KEY`); named profiles via `--profile <name>` and `LEXWARE_API_KEY_<NAME>`. Never print or ask for keys in chat.");
  lines.push("");
  lines.push("## Common tasks");
  lines.push("");
  lines.push(`- Overdue invoices: \`${BIN} invoices list --status overdue\``);
  lines.push(`- Upload a receipt and see what Lexware read: \`${BIN} vouchers upload <file> --wait\`; book it: \`${BIN} vouchers book <id> --body '{...}'\` (preview) → \`--confirm\` after approval`);
  lines.push(`- Posting category ids for voucher items: \`${BIN} ref posting-categories --type outgo --search <text>\``);
  lines.push(`- Invoice draft: \`${BIN} invoices create --body-file inv.json\` (see \`invoices create --help\` for a minimal body)`);
  lines.push(`- Download a document: \`${BIN} invoices file <id> --out <dir>\``);
  lines.push(`- Payment status: \`${BIN} payments get <id>\``);
  lines.push(`- Anything else: \`${BIN} raw GET /v1/<path>\``);
  lines.push("");
  lines.push("## Commands");
  lines.push("");
  for (const r of resources) {
    lines.push(`### ${r.name}${r.german ? ` – ${r.german}` : ""}`);
    lines.push("");
    for (const v of r.verbs) lines.push(`- \`${BIN} ${v.usage}\` – ${v.tier}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
