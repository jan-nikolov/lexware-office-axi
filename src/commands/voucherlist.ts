import { AxiError } from "axi-sdk-js";
import type { AxiStructuredOutput } from "../types.js";
import { requireDate, requireUuid, type FlagSpec } from "../args.js";
import { BIN, countLine, emptyResult, fetchPaged, FIELDS_FLAG, PAGING_FLAGS, rows, sumMoney, type Ctx } from "../core.js";
import { escapeSearch } from "../http.js";
import { voucherlistRow } from "../summary.js";

export const VOUCHER_TYPES = [
  "salesinvoice",
  "salescreditnote",
  "purchaseinvoice",
  "purchasecreditnote",
  "invoice",
  "downpaymentinvoice",
  "creditnote",
  "orderconfirmation",
  "quotation",
  "deliverynote",
] as const;

export const VOUCHER_STATUSES = [
  "draft",
  "open",
  "overdue",
  "paid",
  "paidoff",
  "voided",
  "transferred",
  "sepadebit",
  "accepted",
  "rejected",
  "unchecked",
] as const;

export function listFlags(withType: boolean): FlagSpec[] {
  const flags: FlagSpec[] = [];
  if (withType) {
    flags.push({ name: "type", type: "string", description: `Comma list of voucher types or \`any\`: ${VOUCHER_TYPES.join(", ")}` });
  }
  flags.push(
    {
      name: "status",
      type: "string",
      description: `Comma list or \`any\`: ${VOUCHER_STATUSES.join(", ")}. \`overdue\` cannot be combined`,
      default: "any",
    },
    { name: "date-from", type: "string", description: "Voucher date from (YYYY-MM-DD, inclusive)" },
    { name: "date-to", type: "string", description: "Voucher date to (YYYY-MM-DD, inclusive)" },
    { name: "contact", type: "string", description: "Contact id (UUID)" },
    { name: "number", type: "string", description: "Exact voucher number" },
    { name: "archived", type: "boolean", description: "true = only archived, false = only not archived" },
    { name: "created-from", type: "string", description: "Created from (YYYY-MM-DD)" },
    { name: "created-to", type: "string", description: "Created to (YYYY-MM-DD)" },
    { name: "updated-from", type: "string", description: "Updated from (YYYY-MM-DD)" },
    { name: "updated-to", type: "string", description: "Updated to (YYYY-MM-DD)" },
    {
      name: "sort",
      type: "string",
      description: "voucherDate|voucherNumber|createdDate|updatedDate with optional ,ASC or ,DESC",
      default: "voucherDate,DESC",
    },
    ...PAGING_FLAGS,
    FIELDS_FLAG,
  );
  return flags;
}

function validateList(value: string, allowed: readonly string[], label: string): string {
  if (value === "any") return value;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !allowed.includes(p));
  if (bad.length > 0 || parts.length === 0) {
    throw new AxiError(`Invalid ${label}: ${bad.join(", ") || value}`, "VALIDATION_ERROR", [`Allowed: ${allowed.join(", ")}, or any`]);
  }
  if (label === "status" && parts.includes("overdue") && parts.length > 1) {
    throw new AxiError("`overdue` cannot be combined with other statuses", "VALIDATION_ERROR", [
      "Query --status overdue on its own, and other statuses in a second call",
    ]);
  }
  return parts.join(",");
}

/**
 * Lists documents through GET /v1/voucherlist. Used by `vouchers list` and the list verb
 * of every sales document type.
 */
export async function voucherlist(
  ctx: Ctx,
  opts: { voucherType: string; key: string; what: string; showType: boolean; resource: string },
): Promise<AxiStructuredOutput> {
  const f = ctx.flags;
  const voucherType = validateList((f.type as string | undefined) ?? opts.voucherType, VOUCHER_TYPES, "type");
  const voucherStatus = validateList(String(f.status ?? "any"), VOUCHER_STATUSES, "status");
  const sort = String(f.sort ?? "voucherDate,DESC");
  if (!/^(voucherDate|voucherNumber|createdDate|updatedDate)(,(ASC|DESC))?$/.test(sort)) {
    throw new AxiError(`Invalid --sort: ${sort}`, "VALIDATION_ERROR", ["Use voucherDate|voucherNumber|createdDate|updatedDate[,ASC|DESC]"]);
  }
  const query = {
    voucherType,
    voucherStatus,
    archived: f.archived as boolean | undefined,
    contactId: f.contact ? requireUuid(String(f.contact), "--contact") : undefined,
    voucherNumber: f.number ? escapeSearch(String(f.number)) : undefined,
    voucherDateFrom: requireDate(f["date-from"] as string | undefined, "--date-from"),
    voucherDateTo: requireDate(f["date-to"] as string | undefined, "--date-to"),
    createdDateFrom: requireDate(f["created-from"] as string | undefined, "--created-from"),
    createdDateTo: requireDate(f["created-to"] as string | undefined, "--created-to"),
    updatedDateFrom: requireDate(f["updated-from"] as string | undefined, "--updated-from"),
    updatedDateTo: requireDate(f["updated-to"] as string | undefined, "--updated-to"),
    sort,
  };
  const page = await fetchPaged<Record<string, unknown>>(ctx, "/v1/voucherlist", query);
  const filterNote = voucherStatus === "any" ? "" : ` with status ${voucherStatus}`;
  if (page.items.length === 0) {
    return emptyResult(opts.key, `${opts.what}${filterNote}`, {
      ...(voucherStatus !== "any" || f["date-from"] || f["date-to"] || f.contact || f.number ? { help: ["Widen the filters, e.g. drop --status or the date range"] } : {}),
    });
  }
  const out: AxiStructuredOutput = {
    count: countLine(page.items.length, page.total),
    [opts.key]: rows(ctx, page.items, (i) => voucherlistRow(i, opts.showType)),
    sum_shown: { total: sumMoney(page.items.map((i) => i.totalAmount)), open: sumMoney(page.items.map((i) => i.openAmount)) },
  };
  const help: string[] = [`Run \`${BIN} ${opts.resource} get <id>${ctx.p}\` for details`];
  if (!page.complete && ctx.flags.all !== true) {
    help.push(`More results: add --page ${page.page + 1}, or --all`);
  }
  out.help = help;
  return out;
}
