import { AxiError, runAxiCli } from "axi-sdk-js";
import { encode as renderToon } from "@toon-format/toon";
import type { AxiRenderable, AxiStructuredOutput } from "./types.js";
import { parseArgs, rejectExtraPositionals, requirePositional } from "./args.js";
import { configDir, envNameFor, removeKey, resolveKey, resolveProfile, saveKey, storedProfiles, baseUrl } from "./config.js";
import {
  BIN,
  BODY_FLAGS,
  FULL_FLAG,
  OUT_FLAG,
  PROFILE_FLAG,
  Ctx,
  defaultIo,
  gate,
  readBody,
  resourceCommand,
  saveDownload,
  sumMoney,
  truncateDeep,
  type Io,
  type Resource,
} from "./core.js";
import { LexwareClient, type Method } from "./http.js";
import { VERSION } from "./version.js";
import { salesResources } from "./commands/sales.js";
import { vouchersResource } from "./commands/vouchers.js";
import { articlesResource, contactsResource } from "./commands/contacts.js";
import { filesResource, paymentsResource, profileOutput, recurringResource, refResource, webhooksResource } from "./commands/misc.js";

export const DESCRIPTION =
  "Lexware Office (formerly lexoffice) for agents: invoices, receipts, contacts, payments – the complete public API. Unofficial.";

type Obj = Record<string, unknown>;

// ---------- raw ----------

function rawResource(): Resource {
  return {
    name: "raw",
    summary: "Call any API endpoint directly (escape hatch); every non-GET needs --confirm",
    verbs: [
      {
        name: "GET",
        summary: "GET any /v1 path",
        usage: "raw GET /v1/<path> [--query key=value]... [--accept <type> --out <file>]",
        tier: "read",
        flags: [
          { name: "query", type: "list", description: "Query parameter key=value" },
          { name: "accept", type: "string", description: "Accept header; non-JSON responses are saved with --out", default: "application/json" },
          OUT_FLAG,
          FULL_FLAG,
        ],
        examples: ["raw GET /v1/profile", "raw GET /v1/voucherlist --query voucherType=invoice --query voucherStatus=open"],
        run: (ctx, parsed) => rawCall(ctx, "GET", parsed.positionals),
      },
      ...(["POST", "PUT", "DELETE"] as const).map((method) => ({
        name: method,
        summary: `${method} any /v1 path (binding until proven otherwise: needs --confirm)`,
        usage: `raw ${method} /v1/<path> [--body '{...}'] [--query key=value]... --confirm`,
        tier: "final" as const,
        flags: [{ name: "query", type: "list" as const, description: "Query parameter key=value" }, ...(method === "DELETE" ? [] : BODY_FLAGS)],
        examples: [`raw ${method} /v1/<path>${method === "DELETE" ? "" : " --body '{...}'"} --confirm`],
        run: (ctx: Ctx, parsed: { positionals: string[] }) => rawCall(ctx, method, parsed.positionals),
      })),
    ],
  };
}

async function rawCall(ctx: Ctx, method: Method, positionals: string[]): Promise<AxiRenderable> {
  const raw = positionals[0];
  if (!raw) throw new AxiError("Missing path", "VALIDATION_ERROR", [`Usage: ${BIN} raw ${method} /v1/<path>`]);
  const path = raw.startsWith("/v1/") ? raw : `/v1/${raw.replace(/^\/+/, "")}`;
  if (/\.\.|\/\/|^\/v1\/?$|[?#]/.test(path) || /^https?:/i.test(raw)) {
    throw new AxiError(`Invalid path: ${raw}`, "VALIDATION_ERROR", ["Use a relative API path such as /v1/invoices/<id>; pass query parameters with --query"]);
  }
  const query: Record<string, string> = {};
  for (const kv of (ctx.flags.query as string[] | undefined) ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new AxiError(`--query needs key=value, got: ${kv}`, "VALIDATION_ERROR");
    query[kv.slice(0, i)] = kv.slice(i + 1);
  }
  if (method === "GET") {
    const accept = String(ctx.flags.accept ?? "application/json");
    if (!accept.includes("json")) {
      const res = await ctx.client().binary(path + (Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""), accept);
      return { saved: saveDownload(ctx, res.bytes, res.filename, "download.bin"), bytes: res.bytes.length, content_type: res.contentType };
    }
    const res = await ctx.client().json("GET", path, { query });
    return { status: res.status, data: truncateDeep(res.data ?? null, ctx.flags.full === true) as Obj };
  }
  const body = method === "DELETE" ? undefined : await readBody(ctx, false);
  const stop = gate(ctx, "final", { method, path, query, body }, `Send ${method} ${path} (raw call: treated as binding)`);
  if (stop) return stop;
  const res = await ctx.client().json(method, path, { query, body });
  return { status: res.status, data: (res.data ?? null) as Obj };
}

// ---------- auth ----------

function authResource(io: () => Io): Resource {
  return {
    name: "auth",
    summary: "Store, check and remove API keys per profile",
    verbs: [
      {
        name: "status",
        summary: "Show which profiles have a key and where it comes from; --live also checks it against Lexware",
        usage: "auth status [--live]",
        tier: "read",
        flags: [{ name: "live", type: "boolean", description: "Check each key with one GET /v1/profile" }],
        examples: ["auth status", "auth status --live"],
        run: async (ctx) => {
          const env = ctx.io.env;
          const names = new Set(["default", ...storedProfiles(env)]);
          for (const key of Object.keys(env)) {
            const m = /^LEXWARE_API_KEY_([A-Z0-9_]+)$/.exec(key);
            if (m?.[1]) names.add(m[1].toLowerCase().replace(/_/g, "-"));
          }
          if (ctx.flags.profile) names.add(ctx.profile);
          const profiles: Obj[] = [];
          for (const name of [...names].sort()) {
            const found = resolveKey(name, env);
            const row: Obj = { profile: name, key: found ? found.source : `missing (set ${envNameFor(name)})` };
            if (ctx.flags.live === true) {
              if (!found) row.live = "skipped";
              else {
                try {
                  const client = new LexwareClient({ apiKey: found.key, baseUrl: baseUrl(env), fetch: ctx.io.fetch, sleep: ctx.io.sleep });
                  const res = await client.json<Obj>("GET", "/v1/profile");
                  row.live = `ok: ${String(res.data?.companyName ?? "?")}`;
                } catch (error) {
                  row.live = error instanceof AxiError ? `failed: ${error.code}` : "failed";
                }
              }
            }
            profiles.push(row);
          }
          return { profiles, config_dir: configDir(env), help: [`Store a key: pipe it into \`${BIN} auth set --profile <name>\``] };
        },
      },
      {
        name: "set",
        summary: "Read a key from stdin, verify it with Lexware, store it for the profile (file mode 0600)",
        usage: "auth set [--profile <name>] [--no-check] < keyfile",
        tier: "write",
        flags: [{ name: "no-check", type: "boolean", description: "Store without verifying against /v1/profile" }],
        examples: ["auth set --profile test < key.txt", "pbpaste | lexware-office-axi auth set"],
        run: async (ctx) => {
          const key = (await ctx.io.readStdin()).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
          if (!key) {
            throw new AxiError("No key on stdin", "VALIDATION_ERROR", ["Pipe the key in; it is never accepted as an argument so it stays out of shell history"]);
          }
          let company: unknown = null;
          if (ctx.flags["no-check"] !== true) {
            const client = new LexwareClient({ apiKey: key, baseUrl: baseUrl(ctx.io.env), fetch: ctx.io.fetch, sleep: ctx.io.sleep });
            const res = await client.json<Obj>("GET", "/v1/profile");
            company = res.data?.companyName ?? null;
          }
          if (ctx.flags["dry-run"] === true) return { dry_run: "key verified, nothing stored", company };
          const file = saveKey(ctx.profile, key, ctx.io.env);
          return { stored: { profile: ctx.profile, file, company } };
        },
      },
      {
        name: "remove",
        summary: "Delete the stored key file of a profile (env variables are untouched)",
        usage: "auth remove [--profile <name>]",
        tier: "write",
        flags: [],
        examples: ["auth remove --profile test"],
        run: async (ctx) => {
          if (ctx.flags["dry-run"] === true) return { dry_run: `would remove the key file of ${ctx.profile}` };
          return { removed: removeKey(ctx.profile, ctx.io.env) ? ctx.profile : `${ctx.profile} had no stored key, nothing to do` };
        },
      },
    ],
  };
}

// ---------- home ----------

async function home(io: Io, args: string[]): Promise<AxiStructuredOutput> {
  const parsed = parseArgs(args, [PROFILE_FLAG], `${BIN} [--profile <name>]`);
  const ctx = new Ctx(io, parsed.flags);
  const profile = resolveProfile(parsed.flags.profile as string | undefined, io.env);
  if (!resolveKey(profile, io.env)) {
    return {
      profile,
      setup: "no API key configured",
      help: [
        `Create a key at https://app.lexware.de/addons/public-api`,
        `Then set ${envNameFor(profile)}${profile === "default" ? " (or LEXOFFICE_API_KEY)" : ""}, or pipe it into \`${BIN} auth set${profile === "default" ? "" : ` --profile ${profile}`}\``,
        `Run \`${BIN} --help\` for all commands`,
      ],
    };
  }
  const client = ctx.client();
  const prof = (await client.json<Obj>("GET", "/v1/profile")).data ?? {};
  const list = async (voucherType: string, voucherStatus: string, size: number) =>
    (await client.json<{ content?: Obj[]; totalElements?: number }>("GET", "/v1/voucherlist", {
      query: { voucherType, voucherStatus, page: 0, size, sort: "voucherDate,DESC" },
    })).data ?? {};
  const overdue = await list("invoice", "overdue", 250);
  const open = await list("invoice", "open", 250);
  const unchecked = await list("salesinvoice,salescreditnote,purchaseinvoice,purchasecreditnote", "unchecked", 1);
  const summarize = (body: { content?: Obj[]; totalElements?: number }) => {
    const items = body.content ?? [];
    const total = body.totalElements ?? items.length;
    return { count: total, open_sum: sumMoney(items.map((i) => i.openAmount)), ...(total > items.length ? { note: `sum covers the ${items.length} newest` } : {}) };
  };
  const p = ctx.p;
  return {
    profile,
    company: prof.companyName ?? null,
    invoices: { overdue: summarize(overdue), open_incl_overdue: summarize(open) },
    vouchers_to_review: unchecked.totalElements ?? 0,
    help: [
      `Run \`${BIN} invoices list --status overdue${p}\` for overdue invoices`,
      `Run \`${BIN} vouchers list --status unchecked${p}\` for receipts to review (Zu prüfen)`,
      `Run \`${BIN} vouchers upload <file>${p}\` to upload a receipt`,
      `Run \`${BIN} --help\` for every command`,
    ],
  };
}

// ---------- wiring ----------

export function allResources(io: () => Io): Resource[] {
  return [
    ...salesResources(),
    vouchersResource(),
    contactsResource(),
    articlesResource(),
    paymentsResource(),
    recurringResource(),
    webhooksResource(),
    refResource(),
    filesResource(),
    rawResource(),
    authResource(io),
  ];
}

export function topLevelHelp(resources: Resource[]): string {
  return `${renderToon({
    usage: `${BIN} <command> <verb> [args] [flags]`,
    description: DESCRIPTION,
    commands: [
      { command: "(none)", summary: "Home: overdue/open invoices and receipts to review" },
      { command: "profile", summary: "The connected organisation (company, tax type, features)" },
      ...resources.map((r) => ({ command: r.name, summary: r.german ? `${r.summary} (${r.german})` : r.summary })),
    ],
    tiers: {
      read: "no side effects",
      write: "creates or changes data (drafts, uploads, contacts); add --dry-run to see the request first",
      final: "binding or irreversible (finalize, book, delete, webhooks, raw writes): without --confirm you only get a preview",
    },
    keys: "env LEXWARE_API_KEY (or LEXOFFICE_API_KEY); profile <name>: LEXWARE_API_KEY_<NAME> or `auth set --profile <name>`",
    help: [`Run \`${BIN} <command> --help\` for its verbs, \`${BIN} <command> <verb> --help\` for flags and examples`],
  })}\n`;
}

/**
 * `--profile <name>` is the one global flag, and people naturally put it first
 * (`lexware-office-axi --profile test home`). The SDK only accepts flags after the
 * command, so move leading profile flags to the end. With nothing left, show home.
 */
export function hoistGlobalFlags(argv: string[]): string[] {
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--profile" && i + 1 < argv.length) {
      lead.push(arg, argv[i + 1]!);
      i += 2;
    } else if (arg.startsWith("--profile=")) {
      lead.push(arg);
      i += 1;
    } else break;
  }
  if (lead.length === 0) return argv;
  const rest = argv.slice(i);
  if (rest.length === 0) return ["home", ...lead];
  // --help / --version ignore the profile anyway
  if (rest[0]!.startsWith("-")) return rest;
  return [...rest, ...lead];
}

export async function main(
  argvRaw: string[] = process.argv.slice(2),
  ioOverride?: Io,
  stdout?: { write: (chunk: string) => unknown },
): Promise<void> {
  const argv = hoistGlobalFlags(argvRaw);
  const io = () => ioOverride ?? defaultIo();
  const resources = allResources(io);
  const commands: Record<string, (args: string[]) => Promise<AxiRenderable>> = {};
  for (const r of resources) commands[r.name] = resourceCommand(r, io);
  commands.home = (args) => home(io(), args);
  commands.profile = async (args) => {
    if (args.includes("--help")) {
      return { command: "profile", usage: `${BIN} profile [--profile <name>]`, summary: "The connected organisation without personal data", tier: "read" };
    }
    const parsed = parseArgs(args, [PROFILE_FLAG], `${BIN} profile`);
    rejectExtraPositionals(parsed, 0, `${BIN} profile`);
    return profileOutput(new Ctx(io(), parsed.flags));
  };
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: topLevelHelp(resources),
    commands,
    home: (args) => home(io(), args),
    getCommandHelp: () => undefined,
    stdout,
  });
}

// Re-exported for the skill generator and tests.
export { requirePositional };
