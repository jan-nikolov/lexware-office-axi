import { AxiError } from "axi-sdk-js";
import { rejectExtraPositionals, requirePositional, requireUuid } from "../args.js";
import {
  BIN,
  BODY_FLAGS,
  FULL_FLAG,
  OUT_FLAG,
  deeplink,
  gate,
  readBody,
  saveDownload,
  truncateDeep,
  uploadForm,
  type Ctx,
  type Resource,
} from "../core.js";
import { missingForBooking, voucherSummary } from "../summary.js";
import { listFlags, voucherlist } from "./voucherlist.js";

type Obj = Record<string, unknown>;
const READ_ONLY = ["id", "organizationId", "createdDate", "updatedDate", "archived"];

export function stripReadOnly(obj: Obj): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !READ_ONLY.includes(k)));
}

/** GET current, shallow-merge the patch over it, keep the current version unless the patch sets one. */
export async function mergeForPut(ctx: Ctx, path: string, patch: Obj, replace: boolean): Promise<{ current: Obj; body: Obj }> {
  const current = ((await ctx.client().json<Obj>("GET", path)).data ?? {}) as Obj;
  const base = replace ? {} : stripReadOnly(current);
  const body = stripReadOnly({ ...base, ...patch });
  if (body.version === undefined) body.version = current.version;
  return { current, body };
}

const BOOKKEEPING_TYPES = "salesinvoice,salescreditnote,purchaseinvoice,purchasecreditnote";

const VOUCHER_EXAMPLE = {
  type: "purchaseinvoice",
  taxType: "gross",
  voucherNumber: "RE-4711",
  voucherDate: "2026-11-10",
  totalGrossAmount: 119,
  totalTaxAmount: 19,
  useCollectiveContact: true,
  contactName: "Beispiel GmbH",
  voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: "<posting-category-id>" }],
};

async function getVoucher(ctx: Ctx, id: string): Promise<Obj> {
  return ((await ctx.client().json<Obj>("GET", `/v1/vouchers/${id}`)).data ?? {}) as Obj;
}

export function vouchersResource(): Resource {
  const r = "vouchers";
  return {
    name: r,
    summary: "Bookkeeping vouchers: receipts and booked invoices, upload, attach, book",
    german: "Belege / Buchhaltung",
    verbs: [
      {
        name: "list",
        summary: "List bookkeeping vouchers (default: sales/purchase invoices and credit notes); --type any lists every document",
        usage: `${r} list [--type purchaseinvoice] [--status unchecked|open|...] [--date-from YYYY-MM-DD]`,
        tier: "read",
        flags: listFlags(true),
        examples: [`${r} list --status unchecked`, `${r} list --type purchaseinvoice --status open`, `${r} list --type any --number RE0042`],
        run: (ctx) =>
          voucherlist(ctx, { voucherType: BOOKKEEPING_TYPES, key: r, what: "vouchers", showType: true, resource: r }),
      },
      {
        name: "get",
        summary: "Show one voucher: type, status, number, amounts, items, files, link",
        usage: `${r} get <id> [--full]`,
        tier: "read",
        flags: [FULL_FLAG],
        examples: [`${r} get <id>`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} get <id>`), "id");
          rejectExtraPositionals(parsed, 1, `${BIN} ${r} get <id>`);
          const data = await getVoucher(ctx, id);
          const full = ctx.flags.full === true;
          const help: string[] = [];
          if (data.voucherStatus === "blank") help.push("Status blank: Lexware is still reading the upload; check again in a few seconds");
          if (data.voucherStatus === "unchecked") {
            const missing = missingForBooking(data);
            help.push(
              missing.length
                ? `To book it, provide: ${missing.join(", ")} via \`${BIN} ${r} book ${id} --body '{...}'${ctx.p}\``
                : `Ready to book: \`${BIN} ${r} book ${id}${ctx.p}\``,
            );
          }
          if (Array.isArray(data.files) && data.files.length) help.push(`Run \`${BIN} ${r} file ${id}${ctx.p}\` to download its file`);
          help.push(`Run \`${BIN} payments get ${id}${ctx.p}\` for payment status`);
          return { voucher: truncateDeep(full ? data : voucherSummary(data), full), help };
        },
      },
      {
        name: "upload",
        summary: "Upload a receipt (pdf/jpg/png/xml, max 5 MB); Lexware reads it and creates an unchecked voucher (Zu prüfen)",
        usage: `${r} upload <file> [--wait]`,
        tier: "write",
        tierNote: "creates an unchecked voucher that only the web app can delete; nothing is booked",
        flags: [{ name: "wait", type: "boolean", description: "Wait (up to ~30 s) until Lexware has read the file and show the voucher" }],
        examples: [`${r} upload ./rechnung.pdf --wait`, `${r} upload ./beleg.jpg --dry-run`],
        run: async (ctx, parsed) => {
          const file = requirePositional(parsed, 0, "file", `${BIN} ${r} upload <file>`);
          rejectExtraPositionals(parsed, 1, `${BIN} ${r} upload <file>`);
          const { form, name, bytes } = uploadForm(ctx, file, { type: "voucher" });
          const stop = gate(ctx, "write", { method: "POST", path: "/v1/files", query: { type: "voucher" }, file: `${name} (${bytes} bytes)` },
            "Upload the file; Lexware creates an unchecked voucher (or returns the existing one for an identical file)");
          if (stop) return stop;
          const res = await ctx.client().json<Obj>("POST", "/v1/files", { form });
          const fileId = res.data?.id;
          const voucherId = res.data?.voucherId as string | undefined;
          const out: Obj = { uploaded: { file: name, file_id: fileId ?? null, voucher_id: voucherId ?? null } };
          if (voucherId && ctx.flags.wait === true) {
            let voucher: Obj = {};
            for (let i = 0; i < 15; i++) {
              voucher = await getVoucher(ctx, voucherId);
              if (voucher.voucherStatus && voucher.voucherStatus !== "blank") break;
              await (ctx.io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(2000);
            }
            out.voucher = voucherSummary(voucher);
            if (voucher.voucherStatus === "unchecked") {
              const missing = missingForBooking(voucher);
              out.help = [
                missing.length
                  ? `To book it, provide: ${missing.join(", ")} via \`${BIN} ${r} book ${voucherId} --body '{...}'${ctx.p}\``
                  : `Ready to book: \`${BIN} ${r} book ${voucherId}${ctx.p}\``,
                `Review it in Lexware: ${deeplink("vouchers", voucherId, "edit")}`,
              ];
            } else if (voucher.voucherStatus && voucher.voucherStatus !== "blank") {
              out.note = `Identical file was uploaded before; this is the existing voucher (status ${voucher.voucherStatus})`;
            } else {
              out.help = [`Still processing; run \`${BIN} ${r} get ${voucherId}${ctx.p}\` in a moment`];
            }
          } else if (voucherId) {
            out.help = [`Run \`${BIN} ${r} get ${voucherId}${ctx.p}\` once Lexware has read it (a few seconds)`];
          }
          return out;
        },
      },
      {
        name: "attach",
        summary: "Attach an additional file (pdf/image/xml) to an existing voucher",
        usage: `${r} attach <voucher-id> <file>`,
        tier: "write",
        flags: [],
        examples: [`${r} attach <voucher-id> ./zahlungsbeleg.pdf`],
        run: async (ctx, parsed) => {
          const usage = `${BIN} ${r} attach <voucher-id> <file>`;
          const id = requireUuid(requirePositional(parsed, 0, "voucher id", usage), "voucher id");
          const file = requirePositional(parsed, 1, "file", usage);
          rejectExtraPositionals(parsed, 2, usage);
          const { form, name, bytes } = uploadForm(ctx, file);
          const stop = gate(ctx, "write", { method: "POST", path: `/v1/vouchers/${id}/files`, file: `${name} (${bytes} bytes)` },
            "Attach the file to the voucher (removable only via the web app or a voucher update)");
          if (stop) return stop;
          const res = await ctx.client().json<Obj>("POST", `/v1/vouchers/${id}/files`, { form });
          return { attached: { voucher_id: id, file: name, file_id: res.data?.id ?? null }, help: [`Run \`${BIN} ${r} get ${id}${ctx.p}\``] };
        },
      },
      {
        name: "create",
        summary: "Create a voucher from data – always unchecked (Zu prüfen) unless --book --confirm",
        usage: `${r} create --body-file voucher.json [--book --confirm]`,
        tier: "depends",
        tierNote: "write as unchecked; final with --book (Lexware would book a voucher without status immediately)",
        flags: [...BODY_FLAGS, { name: "book", type: "boolean", description: "Create it as booked (status open). Irreversible; needs --confirm" }],
        bodyExample: VOUCHER_EXAMPLE,
        examples: [`${r} create --body-file voucher.json --dry-run`, `${r} create --body-file voucher.json --book --confirm`],
        run: async (ctx, parsed) => {
          rejectExtraPositionals(parsed, 0, `${BIN} ${r} create --body-file <file>`);
          const body = (await readBody(ctx, true))!;
          const book = ctx.flags.book === true;
          if (!book && body.voucherStatus !== undefined && body.voucherStatus !== "unchecked") {
            throw new AxiError(`voucherStatus "${String(body.voucherStatus)}" books the voucher`, "VALIDATION_ERROR", [
              "Remove voucherStatus to create it unchecked, or use --book --confirm to book it",
            ]);
          }
          body.voucherStatus = book ? "open" : "unchecked";
          if (book) {
            const missing = missingForBooking(body);
            if (missing.length) throw new AxiError(`Cannot book: missing ${missing.join(", ")}`, "VALIDATION_ERROR");
          }
          const stop = gate(ctx, book ? "final" : "write", { method: "POST", path: "/v1/vouchers", body },
            book ? "Create and book the voucher (status open); the API cannot undo this" : "Create an unchecked voucher (deletable only in the web app)");
          if (stop) return stop;
          const res = await ctx.client().json<Obj>("POST", "/v1/vouchers", { body });
          const id = String(res.data?.id ?? "");
          return { created: { id, status: body.voucherStatus, link: deeplink("vouchers", id) }, help: [`Run \`${BIN} ${r} get ${id}${ctx.p}\``] };
        },
      },
      {
        name: "update",
        summary: "Update a voucher (merges your fields into the current one; Lexware only lets unchecked vouchers move to open)",
        usage: `${r} update <id> --body '{...}' [--replace] [--confirm]`,
        tier: "depends",
        tierNote: "final when the result books the voucher (voucherStatus open)",
        flags: [...BODY_FLAGS, { name: "replace", type: "boolean", description: "Send the body as the full voucher instead of merging" }],
        examples: [`${r} update <id> --body '{"remark":"Projekt X"}'`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} update <id>`), "id");
          const patch = (await readBody(ctx, true))!;
          const { current, body } = await mergeForPut(ctx, `/v1/vouchers/${id}`, patch, ctx.flags.replace === true);
          const books = body.voucherStatus === "open" && current.voucherStatus !== "open";
          const stop = gate(ctx, books ? "final" : "write", { method: "PUT", path: `/v1/vouchers/${id}`, body },
            books ? "Book the voucher (unchecked → open); the API cannot undo this" : "Update the voucher; files missing from files[] are removed for good");
          if (stop) return stop;
          await ctx.client().json("PUT", `/v1/vouchers/${id}`, { body });
          return { updated: { id, status: body.voucherStatus ?? null }, help: [`Run \`${BIN} ${r} get ${id}${ctx.p}\``] };
        },
      },
      {
        name: "book",
        summary: "Book an unchecked voucher (unchecked → open), optionally filling missing fields first",
        usage: `${r} book <id> [--body '{"voucherItems":[...]}'] --confirm`,
        tier: "final",
        flags: BODY_FLAGS,
        examples: [`${r} book <id>`, `${r} book <id> --body '{"voucherItems":[{"amount":119,"taxAmount":19,"taxRatePercent":19,"categoryId":"<id>"}]}' --confirm`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "id", `${BIN} ${r} book <id>`), "id");
          rejectExtraPositionals(parsed, 1, `${BIN} ${r} book <id>`);
          const patch = (await readBody(ctx, false)) ?? {};
          const { current, body } = await mergeForPut(ctx, `/v1/vouchers/${id}`, { ...patch, voucherStatus: "open" }, false);
          if (current.voucherStatus === "open") {
            return { voucher: `already booked (status open), nothing to do`, help: [`Run \`${BIN} ${r} get ${id}${ctx.p}\``] };
          }
          if (current.voucherStatus !== "unchecked") {
            throw new AxiError(`Only unchecked vouchers can be booked; this one is ${String(current.voucherStatus)}`, "INVALID_STATE");
          }
          const missing = missingForBooking(body);
          if (missing.length) {
            throw new AxiError(`Cannot book yet: missing ${missing.join(", ")}`, "VALIDATION_ERROR", [
              `Pass them with --body, e.g. ${BIN} ${r} book ${id} --body '{"voucherItems":[...]}'`,
              `Category ids: \`${BIN} ref posting-categories --type outgo\``,
            ]);
          }
          const stop = gate(ctx, "final", { method: "PUT", path: `/v1/vouchers/${id}`, body }, "Book the voucher (unchecked → open); the API cannot undo this");
          if (stop) return stop;
          await ctx.client().json("PUT", `/v1/vouchers/${id}`, { body });
          return { booked: { id, number: body.voucherNumber ?? null, gross: body.totalGrossAmount ?? null, link: deeplink("vouchers", id) } };
        },
      },
      {
        name: "file",
        summary: "Download the file(s) stored on a voucher",
        usage: `${r} file <voucher-id> [--index N] [--out <file|dir>]`,
        tier: "read",
        flags: [OUT_FLAG, { name: "index", type: "number", description: "Which file if there are several (0-based)", default: 0 }],
        examples: [`${r} file <voucher-id> --out ./belege/`],
        run: async (ctx, parsed) => {
          const id = requireUuid(requirePositional(parsed, 0, "voucher id", `${BIN} ${r} file <voucher-id>`), "voucher id");
          const voucher = await getVoucher(ctx, id);
          const files = Array.isArray(voucher.files) ? (voucher.files as string[]) : [];
          if (files.length === 0) return { files: "0 files stored on this voucher" };
          const index = Number(ctx.flags.index ?? 0);
          const fileId = files[index];
          if (!fileId) throw new AxiError(`No file at index ${index}; the voucher has ${files.length}`, "VALIDATION_ERROR");
          const res = await ctx.client().binary(`/v1/files/${fileId}`);
          const saved = saveDownload(ctx, res.bytes, res.filename, `voucher-${id}-${index}`);
          const out: Obj = { saved, bytes: res.bytes.length, content_type: res.contentType };
          if (files.length > 1) out.note = `${files.length} files on this voucher; use --index 0..${files.length - 1}`;
          return out;
        },
      },
    ],
  };
}
