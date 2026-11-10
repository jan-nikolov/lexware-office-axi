import { AxiError } from "axi-sdk-js";
import type { AxiStructuredOutput } from "../types.js";
import { rejectExtraPositionals, requirePositional, requireUuid } from "../args.js";
import {
  BIN,
  BODY_FLAGS,
  FULL_FLAG,
  OUT_FLAG,
  compact,
  deeplink,
  gate,
  willPreview,
  readBody,
  saveDownload,
  truncateDeep,
  type Ctx,
  type Resource,
  type Verb,
} from "../core.js";
import { describeSalesDraft, salesSummary } from "../summary.js";
import { listFlags, voucherlist } from "./voucherlist.js";

interface SalesKind {
  resource: string; // CLI and API path segment
  label: string; // singular, English
  german: string;
  listType?: string; // voucherlist type, if listable
  canCreate: boolean;
  canFinalize: boolean;
  pursueRequired?: boolean; // dunnings
  pursueFrom?: string; // what --from may reference
  formats: string; // Accept values for /file
  linkKind: string;
  example: Record<string, unknown>;
}

const LINE = {
  type: "custom",
  name: "Beratung",
  quantity: 2,
  unitName: "Stunde",
  unitPrice: { currency: "EUR", netAmount: 90, taxRatePercentage: 19 },
};
const BASE = {
  voucherDate: "2026-11-10T00:00:00.000+01:00",
  address: { contactId: "<contact-id>" },
  lineItems: [LINE],
  totalPrice: { currency: "EUR" },
  taxConditions: { taxType: "net" },
};
const SHIP = { shippingConditions: { shippingType: "service", shippingDate: "2026-11-10T00:00:00.000+01:00" } };

export const SALES_KINDS: SalesKind[] = [
  {
    resource: "invoices",
    label: "invoice",
    german: "Rechnungen",
    listType: "invoice",
    canCreate: true,
    canFinalize: true,
    pursueFrom: "quotation, order confirmation or delivery note",
    formats: "pdf, xml (XRechnung), auto",
    linkKind: "invoices",
    example: { ...BASE, ...SHIP },
  },
  {
    resource: "credit-notes",
    label: "credit note",
    german: "Gutschriften / Rechnungskorrekturen",
    listType: "creditnote",
    canCreate: true,
    canFinalize: true,
    pursueFrom: "invoice (links it; finalizing then reduces the invoice's open amount at once)",
    formats: "pdf, xml (XRechnung), auto",
    linkKind: "credit-notes",
    example: { ...BASE, introduction: "Korrektur zu Rechnung RE0001" },
  },
  {
    resource: "quotations",
    label: "quotation",
    german: "Angebote",
    listType: "quotation",
    canCreate: true,
    canFinalize: true,
    formats: "pdf",
    linkKind: "quotations",
    example: { ...BASE, expirationDate: "2026-12-10T00:00:00.000+01:00" },
  },
  {
    resource: "order-confirmations",
    label: "order confirmation",
    german: "Auftragsbestätigungen",
    listType: "orderconfirmation",
    canCreate: true,
    canFinalize: true,
    pursueFrom: "quotation",
    formats: "pdf",
    linkKind: "order-confirmations",
    example: { ...BASE, ...SHIP },
  },
  {
    resource: "delivery-notes",
    label: "delivery note",
    german: "Lieferscheine",
    listType: "deliverynote",
    canCreate: true,
    canFinalize: true,
    pursueFrom: "invoice, quotation or (open) order confirmation",
    formats: "pdf",
    linkKind: "delivery-notes",
    example: {
      voucherDate: BASE.voucherDate,
      address: BASE.address,
      lineItems: [{ type: "custom", name: "Ware", quantity: 1, unitName: "Stück" }],
      taxConditions: { taxType: "net" },
      shippingConditions: { shippingType: "delivery", shippingDate: "2026-11-10T00:00:00.000+01:00" },
    },
  },
  {
    resource: "dunnings",
    label: "dunning",
    german: "Mahnungen",
    canCreate: true,
    canFinalize: false,
    pursueRequired: true,
    pursueFrom: "invoice or down payment invoice (required)",
    formats: "pdf",
    linkKind: "dunnings",
    example: {
      ...BASE,
      lineItems: [{ ...LINE, name: "Mahngebühr", quantity: 1, unitName: "Stück", unitPrice: { currency: "EUR", netAmount: 5, taxRatePercentage: 0 } }],
      ...SHIP,
    },
  },
  {
    resource: "down-payment-invoices",
    label: "down payment invoice",
    german: "Abschlagsrechnungen",
    listType: "downpaymentinvoice",
    canCreate: false,
    canFinalize: false,
    formats: "pdf, xml (XRechnung), auto",
    linkKind: "invoices",
    example: {},
  },
];

const an = (label: string) => (/^[aeiou]/.test(label) ? `an ${label}` : `a ${label}`);

export function salesResource(kind: SalesKind): Resource {
  const r = kind.resource;
  const verbs: Verb[] = [];

  if (kind.listType) {
    verbs.push({
      name: "list",
      summary: `List ${kind.label}s with status, dates, amounts (via voucherlist)`,
      usage: `${r} list [--status open|overdue|...] [--date-from YYYY-MM-DD] [--contact <id>]`,
      tier: "read",
      flags: listFlags(false),
      examples: [`${r} list --status overdue`, `${r} list --status open --date-from 2026-01-01 --all`],
      run: (ctx) => voucherlist(ctx, { voucherType: kind.listType!, key: r, what: `${kind.label}s`, showType: false, resource: r }),
    });
  }

  verbs.push({
    name: "get",
    summary: `Show one ${kind.label}: number, status, contact, amounts, line items, link`,
    usage: `${r} get <id> [--full]`,
    tier: "read",
    flags: [FULL_FLAG],
    examples: [`${r} get <id>`, `${r} get <id> --full`],
    run: async (ctx, parsed) => {
      const usage = `${BIN} ${r} get <id>`;
      const id = requireUuid(requirePositional(parsed, 0, "id", usage), "id");
      rejectExtraPositionals(parsed, 1, usage);
      const res = await ctx.client().json("GET", `/v1/${r}/${id}`);
      const full = ctx.flags.full === true;
      const shown = full ? res.data : salesSummary(res.data, kind.linkKind);
      const status = (res.data as Record<string, unknown>)?.voucherStatus;
      const help = [`Run \`${BIN} ${r} file ${id}${ctx.p}\` to download the document`];
      if (status === "draft") help[0] = `Draft: no document yet; finalize it in Lexware or recreate it with --finalize`;
      if (r === "invoices" || r === "credit-notes" || r === "down-payment-invoices") {
        help.push(`Run \`${BIN} payments get ${id}${ctx.p}\` for payment status`);
      }
      return { [kind.label.replace(/ /g, "_")]: truncateDeep(shown, full), help };
    },
  });

  if (kind.canCreate) {
    const flags = [...BODY_FLAGS];
    if (kind.pursueFrom) {
      flags.push({
        name: "from",
        type: "string",
        description: `Create as follow-up of a preceding document (precedingSalesVoucherId): ${kind.pursueFrom}`,
        required: kind.pursueRequired,
      });
    }
    if (kind.canFinalize) {
      flags.push({
        name: "finalize",
        type: "boolean",
        description: "Issue the document right away (assigns the number, not editable, irreversible). Needs --confirm",
      });
    }
    verbs.push({
      name: "create",
      summary: kind.canFinalize
        ? `Create ${an(kind.label)} – always a draft unless --finalize --confirm`
        : `Create ${an(kind.label)} (Lexware keeps dunnings as drafts)`,
      usage: `${r} create --body-file ${r}.json${kind.pursueRequired ? " --from <invoice-id>" : ""}${kind.canFinalize ? " [--finalize --confirm]" : ""}`,
      tier: kind.canFinalize ? "depends" : "write",
      tierNote: kind.canFinalize ? "write as draft; final with --finalize" : undefined,
      flags,
      bodyExample: kind.example,
      examples: [
        `${r} create --body-file ${r}.json${kind.pursueRequired ? " --from <invoice-id>" : ""} --dry-run`,
        ...(kind.pursueFrom && !kind.pursueRequired ? [`${r} create --from <preceding-id> --body-file ${r}.json`] : []),
        ...(kind.canFinalize ? [`${r} create --body-file ${r}.json --finalize --confirm`] : []),
      ],
      run: async (ctx, parsed) => {
        rejectExtraPositionals(parsed, 0, `${BIN} ${r} create --body-file <file>`);
        const body = (await readBody(ctx, true))!;
        const from = ctx.flags.from ? requireUuid(String(ctx.flags.from), "--from") : undefined;
        const finalize = ctx.flags.finalize === true;
        const query = { finalize: finalize ? "true" : undefined, precedingSalesVoucherId: from };
        let effect = finalize
          ? `Issue ${an(kind.label)} with a number; it cannot be edited or deleted afterwards`
          : `Create a draft ${kind.label}; drafts can only be deleted in the Lexware web app`;
        if (finalize && r === "credit-notes" && from) effect += "; the linked invoice's open amount drops immediately";
        const about = finalize && willPreview(ctx, "final") ? await describeSalesDraft(ctx, kind.label, body) : undefined;
        const stop = gate(ctx, finalize ? "final" : "write", { method: "POST", path: `/v1/${r}`, query, body }, effect, about);
        if (stop) return stop;
        const res = await ctx.client().json<Record<string, unknown>>("POST", `/v1/${r}`, { query, body });
        const id = String(res.data?.id ?? "");
        let created: Record<string, unknown> = { id };
        if (id) {
          try {
            const got = await ctx.client().json("GET", `/v1/${r}/${id}`);
            const s = salesSummary(got.data, kind.linkKind);
            created = compact({ id, number: s.number, status: s.status, contact: s.contact, gross: s.gross, link: deeplink(kind.linkKind, id, finalize ? "view" : "edit") });
          } catch {
            created = { id, link: deeplink(kind.linkKind, id) };
          }
        }
        const help = finalize || !kind.canFinalize
          ? [`Run \`${BIN} ${r} file ${id}${ctx.p}\` to download the document`]
          : [`Review the draft at the link; Lexware's API cannot finalize or delete an existing draft`];
        return { created, help };
      },
    });
  }

  verbs.push({
    name: "file",
    summary: `Download the ${kind.label} document (${kind.formats})`,
    usage: `${r} file <id> [--out <file|dir>] [--format pdf|xml|auto]`,
    tier: "read",
    flags: [
      OUT_FLAG,
      { name: "format", type: "string", description: "pdf, xml (XRechnung only) or auto (Lexware default)", default: "auto", values: ["pdf", "xml", "auto"] },
    ],
    examples: [`${r} file <id>`, `${r} file <id> --out ./belege/`],
    run: async (ctx, parsed) => {
      const usage = `${BIN} ${r} file <id>`;
      const id = requireUuid(requirePositional(parsed, 0, "id", usage), "id");
      rejectExtraPositionals(parsed, 1, usage);
      const format = String(ctx.flags.format ?? "auto");
      const accept = format === "pdf" ? "application/pdf" : format === "xml" ? "application/xml" : "*/*";
      const path = `/v1/${r}/${id}/file`;
      let res;
      try {
        res = await ctx.client().binary(path, accept);
      } catch (error) {
        if (error instanceof AxiError && error.code === "CONFLICT") {
          throw new AxiError(`This ${kind.label} is a draft; drafts have no document`, "DRAFT_HAS_NO_DOCUMENT", [
            `Finalize it in Lexware, or recreate it with \`${BIN} ${r} create --finalize --confirm\``,
          ]);
        }
        if (error instanceof AxiError && error.code === "NOT_FOUND" && r !== "down-payment-invoices") {
          // API-created documents may need a render trigger first (deprecated /document endpoint).
          await ctx.client().json("GET", `/v1/${r}/${id}/document`).catch(() => undefined);
          res = await ctx.client().binary(path, accept);
        } else {
          throw error;
        }
      }
      const ext = res.contentType.includes("xml") ? "xml" : "pdf";
      const saved = saveDownload(ctx, res.bytes, res.filename, `${kind.resource}-${id}.${ext}`);
      return { saved, bytes: res.bytes.length, content_type: res.contentType };
    },
  });

  if (r !== "down-payment-invoices") {
    verbs.push({
      name: "render",
      summary: "Trigger document rendering and return the documentFileId (deprecated by Lexware; `file` does this for you)",
      usage: `${r} render <id>`,
      tier: "read",
      flags: [],
      examples: [`${r} render <id>`],
      run: async (ctx, parsed) => {
        const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} render <id>`), "id");
        const res = await ctx.client().json<Record<string, unknown>>("GET", `/v1/${r}/${id}/document`);
        return { document_file_id: res.data?.documentFileId ?? null, help: [`Prefer \`${BIN} ${r} file ${id}\``] };
      },
    });
  }

  return {
    name: r,
    summary: `${kind.label[0]!.toUpperCase()}${kind.label.slice(1)}s${kind.canCreate ? "" : " (read-only in the API)"}`,
    german: kind.german,
    verbs,
  };
}

export const salesResources = (): Resource[] => SALES_KINDS.map(salesResource);

export function salesSummaryOutput(data: unknown, linkKind: string): AxiStructuredOutput {
  return salesSummary(data, linkKind);
}
