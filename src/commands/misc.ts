import { AxiError } from "axi-sdk-js";
import type { AxiStructuredOutput } from "../types.js";
import { rejectExtraPositionals, requirePositional, requireUuid } from "../args.js";
import {
  BIN,
  FIELDS_FLAG,
  FULL_FLAG,
  OUT_FLAG,
  PAGING_FLAGS,
  countLine,
  emptyResult,
  fetchPaged,
  gate,
  rows,
  saveDownload,
  truncateDeep,
  uploadForm,
  type Ctx,
  type Resource,
} from "../core.js";
import { paymentSummary, recurringRow, recurringSummary } from "../summary.js";

type Obj = Record<string, unknown>;

export function paymentsResource(): Resource {
  return {
    name: "payments",
    summary: "Payment status of an invoice, credit note or voucher",
    german: "Zahlungen",
    verbs: [
      {
        name: "get",
        summary: "Open amount, payment status and payment items for one document",
        usage: "payments get <voucher-or-invoice-id>",
        tier: "read",
        flags: [],
        examples: ["payments get <invoice-id>"],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} payments get <id>`), "id");
          rejectExtraPositionals(parsed, 1, `${BIN} payments get <id>`);
          const res = await ctx.client().json("GET", `/v1/payments/${id}`);
          return { payment: paymentSummary(res.data) };
        },
      },
    ],
  };
}

export function recurringResource(): Resource {
  const r = "recurring-templates";
  return {
    name: r,
    summary: "Recurring invoice templates (read-only in the API)",
    german: "Wiederkehrende Rechnungen",
    verbs: [
      {
        name: "list",
        summary: "List templates with interval, next run and status",
        usage: `${r} list [--sort nextExecutionDate,ASC]`,
        tier: "read",
        flags: [
          {
            name: "sort",
            type: "string",
            description: "createdDate|updatedDate|lastExecutionDate|nextExecutionDate with optional ,ASC or ,DESC",
            default: "updatedDate,DESC",
          },
          ...PAGING_FLAGS,
          FIELDS_FLAG,
        ],
        examples: [`${r} list`, `${r} list --sort nextExecutionDate,ASC --size 5`],
        run: async (ctx) => {
          const sort = String(ctx.flags.sort);
          if (!/^(createdDate|updatedDate|lastExecutionDate|nextExecutionDate)(,(ASC|DESC))?$/.test(sort)) {
            throw new AxiError(`Invalid --sort: ${sort}`, "VALIDATION_ERROR");
          }
          const page = await fetchPaged<Obj>(ctx, `/v1/${r}`, { sort });
          if (page.items.length === 0) return emptyResult("templates", "recurring templates");
          const help = [`Run \`${BIN} ${r} get <id>${ctx.p}\` for line items and schedule`];
          if (!page.complete && ctx.flags.all !== true) help.push(`More results: add --page ${page.page + 1}, or --all`);
          return { count: countLine(page.items.length, page.total), templates: rows(ctx, page.items, recurringRow), help };
        },
      },
      {
        name: "get",
        summary: "Show one template with schedule and last run result",
        usage: `${r} get <id> [--full]`,
        tier: "read",
        flags: [FULL_FLAG],
        examples: [`${r} get <id>`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} get <id>`), "id");
          const res = await ctx.client().json("GET", `/v1/${r}/${id}`);
          const full = ctx.flags.full === true;
          return { template: truncateDeep(full ? res.data : recurringSummary(res.data), full) };
        },
      },
    ],
  };
}

export const EVENT_TYPES = [
  "article.created", "article.changed", "article.deleted",
  "contact.created", "contact.changed", "contact.deleted",
  "credit-note.created", "credit-note.changed", "credit-note.deleted", "credit-note.status.changed",
  "delivery-note.created", "delivery-note.changed", "delivery-note.deleted", "delivery-note.status.changed",
  "down-payment-invoice.created", "down-payment-invoice.changed", "down-payment-invoice.deleted", "down-payment-invoice.status.changed",
  "dunning.created", "dunning.changed", "dunning.deleted",
  "invoice.created", "invoice.changed", "invoice.deleted", "invoice.status.changed",
  "order-confirmation.created", "order-confirmation.changed", "order-confirmation.deleted", "order-confirmation.status.changed",
  "payment.changed",
  "quotation.created", "quotation.changed", "quotation.deleted", "quotation.status.changed",
  "recurring-template.created", "recurring-template.changed", "recurring-template.deleted",
  "token.revoked",
  "voucher.created", "voucher.changed", "voucher.deleted", "voucher.status.changed",
] as const;

export function webhooksResource(): Resource {
  const r = "webhooks";
  const row = (s: Obj) => ({ id: s.subscriptionId ?? s.id ?? null, event: s.eventType ?? null, url: s.callbackUrl ?? null, created: typeof s.createdDate === "string" ? s.createdDate.slice(0, 10) : null });
  return {
    name: r,
    summary: "Event subscriptions: Lexware POSTs {eventType, resourceId} to your HTTPS URL",
    german: "Webhooks / Event-Abos",
    verbs: [
      {
        name: "list",
        summary: "List event subscriptions of this key",
        usage: `${r} list`,
        tier: "read",
        flags: [],
        examples: [`${r} list`],
        run: async (ctx) => {
          const res = await ctx.client().json<{ content?: Obj[] }>("GET", "/v1/event-subscriptions");
          const items = res.data?.content ?? [];
          if (items.length === 0) return emptyResult(r, "event subscriptions", { help: [`Create one: \`${BIN} ${r} create --event invoice.created --url https://…\``] });
          return { count: items.length, [r]: items.map(row) };
        },
      },
      {
        name: "get",
        summary: "Show one subscription",
        usage: `${r} get <id>`,
        tier: "read",
        flags: [],
        examples: [`${r} get <id>`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} get <id>`), "id");
          const res = await ctx.client().json<Obj>("GET", `/v1/event-subscriptions/${id}`);
          return { webhook: row(res.data ?? {}) };
        },
      },
      {
        name: "create",
        summary: "Subscribe an HTTPS URL to an event (sends your business events to that URL)",
        usage: `${r} create --event <type> --url https://… --confirm`,
        tier: "final",
        tierNote: "outward-facing: Lexware will send event notifications to the URL",
        flags: [
          { name: "event", type: "string", description: "Event type", required: true, values: EVENT_TYPES },
          { name: "url", type: "string", description: "HTTPS callback URL (Lexware checks it with a HEAD request)", required: true },
        ],
        examples: [`${r} create --event invoice.status.changed --url https://example.org/hooks/lexware`],
        run: async (ctx) => {
          const url = String(ctx.flags.url);
          if (!/^https:\/\//.test(url)) throw new AxiError("--url must start with https://", "VALIDATION_ERROR");
          const body = { eventType: ctx.flags.event, callbackUrl: url };
          const stop = gate(ctx, "final", { method: "POST", path: "/v1/event-subscriptions", body }, `Send ${String(ctx.flags.event)} events to ${url}`);
          if (stop) return stop;
          try {
            const res = await ctx.client().json<Obj>("POST", "/v1/event-subscriptions", { body });
            return { created: { id: res.data?.id ?? res.data?.subscriptionId ?? null, event: body.eventType, url } };
          } catch (error) {
            if (error instanceof AxiError && error.code === "CONFLICT") {
              return { webhook: "already subscribed with this event and URL, nothing to do" };
            }
            throw error;
          }
        },
      },
      {
        name: "delete",
        summary: "Delete an event subscription",
        usage: `${r} delete <id> --confirm`,
        tier: "final",
        flags: [],
        examples: [`${r} delete <id> --confirm`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} delete <id>`), "id");
          const stop = gate(ctx, "final", { method: "DELETE", path: `/v1/event-subscriptions/${id}` }, "Delete the subscription");
          if (stop) return stop;
          try {
            await ctx.client().json("DELETE", `/v1/event-subscriptions/${id}`);
          } catch (error) {
            if (error instanceof AxiError && error.code === "NOT_FOUND") return { deleted: `${id} was already gone, nothing to do` };
            throw error;
          }
          return { deleted: id };
        },
      },
    ],
  };
}

export function refResource(): Resource {
  const r = "ref";
  const simple = (name: string, path: string, summary: string, map: (x: Obj) => Obj) => ({
    name,
    summary,
    usage: `${r} ${name}`,
    tier: "read" as const,
    flags: [FIELDS_FLAG],
    examples: [`${r} ${name}`],
    run: async (ctx: Ctx) => {
      const res = await ctx.client().json<Obj[] | { content?: Obj[] }>("GET", path);
      const items = Array.isArray(res.data) ? res.data : (res.data?.content ?? []);
      if (items.length === 0) return emptyResult(name, name.replace(/-/g, " "));
      return { count: items.length, [name]: rows(ctx, items, map) };
    },
  });
  return {
    name: r,
    summary: "Reference data: countries, posting categories, payment conditions, print layouts",
    german: "Stammdaten",
    verbs: [
      simple("countries", "/v1/countries", "Countries with tax classification (de, intraCommunity, thirdPartyCountry)", (c) => ({
        code: c.countryCode ?? null,
        name: c.countryNameDE ?? c.countryNameEN ?? null,
        tax: c.taxClassification ?? null,
      })),
      {
        name: "posting-categories",
        summary: "Posting categories (Buchungskategorien) for voucher items; never hard-code their ids",
        usage: `${r} posting-categories [--type income|outgo] [--search <text>]`,
        tier: "read",
        flags: [
          { name: "type", type: "string", description: "income (sales) or outgo (purchases)", values: ["income", "outgo"] },
          { name: "search", type: "string", description: "Name or group contains (case-insensitive)" },
          FIELDS_FLAG,
        ],
        examples: [`${r} posting-categories --type outgo --search reise`],
        run: async (ctx) => {
          const res = await ctx.client().json<Obj[]>("GET", "/v1/posting-categories");
          let items = Array.isArray(res.data) ? res.data : [];
          if (ctx.flags.type) items = items.filter((c) => c.type === ctx.flags.type);
          const q = (ctx.flags.search as string | undefined)?.toLowerCase();
          if (q) items = items.filter((c) => `${c.name} ${c.groupName}`.toLowerCase().includes(q));
          if (items.length === 0) return emptyResult("categories", "posting categories");
          return {
            count: items.length,
            categories: rows(ctx, items, (c) => ({
              id: c.id ?? null,
              name: c.name ?? null,
              type: c.type ?? null,
              group: c.groupName ?? null,
              contact_required: c.contactRequired === true,
              split_allowed: c.splitAllowed === true,
            })),
          };
        },
      },
      simple("payment-conditions", "/v1/payment-conditions", "Payment conditions (Zahlungsbedingungen); one is the default", (c) => {
        const discount = (c.paymentDiscountConditions ?? {}) as Obj;
        return {
          id: c.id ?? null,
          label: c.paymentTermLabelTemplate ?? null,
          days: c.paymentTermDuration ?? null,
          discount_pct: discount.discountPercentage ?? null,
          discount_days: discount.discountRange ?? null,
          default: c.organizationDefault === true,
        };
      }),
      simple("print-layouts", "/v1/print-layouts", "Print layouts for sales documents", (l) => ({
        id: l.id ?? null,
        name: l.name ?? null,
        default: l.default === true,
      })),
    ],
  };
}

export function filesResource(): Resource {
  const r = "files";
  return {
    name: r,
    summary: "Stored files of bookkeeping vouchers",
    german: "Dateien",
    verbs: [
      {
        name: "get",
        summary: "Download a stored file by file id (bookkeeping vouchers; sales documents: use `<type> file`)",
        usage: `${r} get <file-id> [--out <file|dir>] [--format auto|pdf|xml|png|jpg]`,
        tier: "read",
        flags: [
          OUT_FLAG,
          { name: "format", type: "string", description: "Representation to request", default: "auto", values: ["auto", "pdf", "xml", "png", "jpg"] },
        ],
        examples: [`${r} get <file-id> --out ./belege/`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "file id", `${BIN} ${r} get <file-id>`), "file id");
          const accept = { auto: "*/*", pdf: "application/pdf", xml: "application/xml", png: "image/png", jpg: "image/jpeg" }[String(ctx.flags.format)] ?? "*/*";
          const res = await ctx.client().binary(`/v1/files/${id}`, accept);
          const saved = saveDownload(ctx, res.bytes, res.filename, `file-${id}`);
          return { saved, bytes: res.bytes.length, content_type: res.contentType };
        },
      },
      {
        name: "upload",
        summary: "Same as `vouchers upload`: upload a receipt, Lexware creates an unchecked voucher",
        usage: `${r} upload <file>`,
        tier: "write",
        flags: [],
        examples: [`${r} upload ./rechnung.pdf`],
        run: async (ctx, parsed) => {
          const file = requirePositional(parsed, 0, "file", `${BIN} ${r} upload <file>`);
          const { form, name, bytes } = uploadForm(ctx, file, { type: "voucher" });
          const stop = gate(ctx, "write", { method: "POST", path: "/v1/files", query: { type: "voucher" }, file: `${name} (${bytes} bytes)` }, "Upload the file as a voucher");
          if (stop) return stop;
          const res = await ctx.client().json<Obj>("POST", "/v1/files", { form });
          const voucherId = res.data?.voucherId;
          return {
            uploaded: { file: name, file_id: res.data?.id ?? null, voucher_id: voucherId ?? null },
            help: voucherId ? [`Run \`${BIN} vouchers get ${String(voucherId)}${ctx.p}\` in a few seconds`] : [],
          };
        },
      },
    ],
  };
}

/** Profile without the account owner's personal data. */
export async function profileOutput(ctx: Ctx): Promise<AxiStructuredOutput> {
  const res = await ctx.client().json<Obj>("GET", "/v1/profile");
  const p = res.data ?? {};
  return {
    organization: {
      id: p.organizationId ?? null,
      company: p.companyName ?? null,
      tax_type: p.taxType ?? null,
      small_business: p.smallBusiness === true,
      distance_sales_principle: p.distanceSalesPrinciple ?? null,
      features: Array.isArray(p.businessFeatures) ? p.businessFeatures.join(", ") : null,
    },
  };
}
