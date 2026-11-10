import { AxiError } from "axi-sdk-js";
import { rejectExtraPositionals, requirePositional, requireUuid } from "../args.js";
import {
  BIN,
  BODY_FLAGS,
  FIELDS_FLAG,
  FULL_FLAG,
  PAGING_FLAGS,
  countLine,
  emptyResult,
  fetchPaged,
  gate,
  readBody,
  rows,
  truncateDeep,
  type Resource,
} from "../core.js";
import { escapeSearch } from "../http.js";
import { articleRow, articleSummary, contactRow, contactSummary } from "../summary.js";
import { mergeForPut } from "./vouchers.js";

const CONTACT_EXAMPLE = {
  roles: { customer: {} },
  company: { name: "Beispiel GmbH" },
  addresses: { billing: [{ street: "Musterstraße 1", zip: "50667", city: "Köln", countryCode: "DE" }] },
  emailAddresses: { business: ["rechnung@beispiel.de"] },
};

export function contactsResource(): Resource {
  const r = "contacts";
  return {
    name: r,
    summary: "Customers and vendors",
    german: "Kontakte / Kunden / Lieferanten",
    verbs: [
      {
        name: "list",
        summary: "Search contacts by name, email, number or role",
        usage: `${r} list [--name <text>] [--email <text>] [--number N] [--customer] [--vendor]`,
        tier: "read",
        flags: [
          { name: "name", type: "string", description: "Name contains (min. 3 characters)" },
          { name: "email", type: "string", description: "Email contains (min. 3 characters)" },
          { name: "number", type: "number", description: "Customer or vendor number" },
          { name: "customer", type: "boolean", description: "true = has customer role, false = has not" },
          { name: "vendor", type: "boolean", description: "true = has vendor role, false = has not" },
          ...PAGING_FLAGS,
          FIELDS_FLAG,
        ],
        examples: [`${r} list --name "Beispiel"`, `${r} list --vendor --all`],
        run: async (ctx) => {
          const f = ctx.flags;
          for (const k of ["name", "email"]) {
            if (typeof f[k] === "string" && (f[k] as string).length < 3) {
              throw new AxiError(`--${k} needs at least 3 characters`, "VALIDATION_ERROR");
            }
          }
          const page = await fetchPaged<Record<string, unknown>>(ctx, "/v1/contacts", {
            name: f.name ? escapeSearch(String(f.name)) : undefined,
            email: f.email ? escapeSearch(String(f.email)) : undefined,
            number: f.number as number | undefined,
            customer: f.customer as boolean | undefined,
            vendor: f.vendor as boolean | undefined,
          });
          if (page.items.length === 0) return emptyResult(r, "contacts", f.name || f.email ? { help: ["Name and email search match substrings; try a shorter part"] } : {});
          const help = [`Run \`${BIN} ${r} get <id>${ctx.p}\` for address, email, numbers`];
          if (!page.complete && f.all !== true) help.push(`More results: add --page ${page.page + 1}, or --all`);
          return { count: countLine(page.items.length, page.total), [r]: rows(ctx, page.items, contactRow), help };
        },
      },
      {
        name: "get",
        summary: "Show one contact: numbers, email, phone, billing address",
        usage: `${r} get <id> [--full]`,
        tier: "read",
        flags: [FULL_FLAG],
        examples: [`${r} get <id>`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} get <id>`), "id");
          rejectExtraPositionals(parsed, 1, `${BIN} ${r} get <id>`);
          const res = await ctx.client().json("GET", `/v1/contacts/${id}`);
          const full = ctx.flags.full === true;
          return {
            contact: truncateDeep(full ? res.data : contactSummary(res.data), full),
            help: [`Run \`${BIN} invoices list --contact ${id}${ctx.p}\` for this contact's invoices`],
          };
        },
      },
      {
        name: "create",
        summary: "Create a customer and/or vendor (company or person)",
        usage: `${r} create --body-file contact.json`,
        tier: "write",
        tierNote: "contacts cannot be deleted via the API, only archived in the web app",
        flags: BODY_FLAGS,
        bodyExample: CONTACT_EXAMPLE,
        examples: [`${r} create --body-file contact.json --dry-run`],
        run: async (ctx, parsed) => {
          rejectExtraPositionals(parsed, 0, `${BIN} ${r} create --body-file <file>`);
          const body = (await readBody(ctx, true))!;
          if (body.version === undefined) body.version = 0;
          const stop = gate(ctx, "write", { method: "POST", path: "/v1/contacts", body }, "Create the contact (no API delete; archive in the web app)");
          if (stop) return stop;
          const res = await ctx.client().json<Record<string, unknown>>("POST", "/v1/contacts", { body });
          const id = String(res.data?.id ?? "");
          return { created: { id }, help: [`Run \`${BIN} ${r} get ${id}${ctx.p}\` to see the assigned customer/vendor number`] };
        },
      },
      {
        name: "update",
        summary: "Update a contact (merges your fields into the current contact; version handled for you)",
        usage: `${r} update <id> --body '{...}' [--replace]`,
        tier: "write",
        tierNote: "Lexware refuses updates for contacts with more than one address/email/phone per kind or several contact persons",
        flags: [...BODY_FLAGS, { name: "replace", type: "boolean", description: "Send the body as the full contact instead of merging" }],
        examples: [`${r} update <id> --body '{"note":"Zahlt immer pünktlich"}'`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} update <id>`), "id");
          rejectExtraPositionals(parsed, 1, `${BIN} ${r} update <id>`);
          const patch = (await readBody(ctx, true))!;
          const { body } = await mergeForPut(ctx, `/v1/contacts/${id}`, patch, ctx.flags.replace === true);
          const stop = gate(ctx, "write", { method: "PUT", path: `/v1/contacts/${id}`, body }, "Update the contact");
          if (stop) return stop;
          await ctx.client().json("PUT", `/v1/contacts/${id}`, { body });
          return { updated: { id }, help: [`Run \`${BIN} ${r} get ${id}${ctx.p}\``] };
        },
      },
    ],
  };
}

const ARTICLE_EXAMPLE = {
  title: "Beratung",
  type: "SERVICE",
  unitName: "Stunde",
  price: { leadingPrice: "NET", netPrice: 90, taxRate: 19 },
};

export function articlesResource(): Resource {
  const r = "articles";
  return {
    name: r,
    summary: "Products and services catalogue",
    german: "Artikel",
    verbs: [
      {
        name: "list",
        summary: "List articles, optionally by number, GTIN or type",
        usage: `${r} list [--number <articleNumber>] [--gtin <gtin>] [--type PRODUCT|SERVICE]`,
        tier: "read",
        flags: [
          { name: "number", type: "string", description: "Exact article number" },
          { name: "gtin", type: "string", description: "GTIN-8/12/13/14" },
          { name: "type", type: "string", description: "PRODUCT or SERVICE", values: ["PRODUCT", "SERVICE"] },
          ...PAGING_FLAGS,
          FIELDS_FLAG,
        ],
        examples: [`${r} list`, `${r} list --type SERVICE`],
        run: async (ctx) => {
          const f = ctx.flags;
          const page = await fetchPaged<Record<string, unknown>>(ctx, "/v1/articles", {
            articleNumber: f.number as string | undefined,
            gtin: f.gtin as string | undefined,
            type: f.type as string | undefined,
          });
          if (page.items.length === 0) return emptyResult(r, "articles");
          const help = [`Run \`${BIN} ${r} get <id>${ctx.p}\``];
          if (!page.complete && f.all !== true) help.push(`More results: add --page ${page.page + 1}, or --all`);
          return { count: countLine(page.items.length, page.total), [r]: rows(ctx, page.items, articleRow), help };
        },
      },
      {
        name: "get",
        summary: "Show one article",
        usage: `${r} get <id> [--full]`,
        tier: "read",
        flags: [FULL_FLAG],
        examples: [`${r} get <id>`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} get <id>`), "id");
          const res = await ctx.client().json("GET", `/v1/articles/${id}`);
          const full = ctx.flags.full === true;
          return { article: truncateDeep(full ? res.data : articleSummary(res.data), full) };
        },
      },
      {
        name: "create",
        summary: "Create an article",
        usage: `${r} create --body-file article.json`,
        tier: "write",
        flags: BODY_FLAGS,
        bodyExample: ARTICLE_EXAMPLE,
        examples: [`${r} create --body-file article.json`],
        run: async (ctx, parsed) => {
          rejectExtraPositionals(parsed, 0, `${BIN} ${r} create --body-file <file>`);
          const body = (await readBody(ctx, true))!;
          const stop = gate(ctx, "write", { method: "POST", path: "/v1/articles", body }, "Create the article");
          if (stop) return stop;
          const res = await ctx.client().json<Record<string, unknown>>("POST", "/v1/articles", { body });
          return { created: { id: res.data?.id ?? null } };
        },
      },
      {
        name: "update",
        summary: "Update an article (merges into the current one)",
        usage: `${r} update <id> --body '{...}' [--replace]`,
        tier: "write",
        flags: [...BODY_FLAGS, { name: "replace", type: "boolean", description: "Send the body as the full article instead of merging" }],
        examples: [`${r} update <id> --body '{"price":{"leadingPrice":"NET","netPrice":95,"taxRate":19}}'`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} update <id>`), "id");
          const patch = (await readBody(ctx, true))!;
          const { body } = await mergeForPut(ctx, `/v1/articles/${id}`, patch, ctx.flags.replace === true);
          const stop = gate(ctx, "write", { method: "PUT", path: `/v1/articles/${id}`, body }, "Update the article");
          if (stop) return stop;
          await ctx.client().json("PUT", `/v1/articles/${id}`, { body });
          return { updated: { id } };
        },
      },
      {
        name: "delete",
        summary: "Delete an article for good",
        usage: `${r} delete <id> --confirm`,
        tier: "final",
        flags: [],
        examples: [`${r} delete <id>`, `${r} delete <id> --confirm`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} delete <id>`), "id");
          const stop = gate(ctx, "final", { method: "DELETE", path: `/v1/articles/${id}` }, "Delete the article permanently");
          if (stop) return stop;
          try {
            await ctx.client().json("DELETE", `/v1/articles/${id}`);
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
