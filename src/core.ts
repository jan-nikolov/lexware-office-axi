import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { AxiStructuredOutput, AxiRenderable } from "./types.js";
import { parseArgs, type FlagSpec, type FlagValues, type ParsedArgs } from "./args.js";
import { baseUrl, requireKey, resolveProfile } from "./config.js";
import { LexwareClient, type Method, type Query } from "./http.js";

export const BIN = "lexware-office-axi";
export const APP_URL = "https://app.lexware.de";

/** read: no side effects. write: creates or changes reversible/non-binding data. final: binding, irreversible or outward-facing. */
export type Tier = "read" | "write" | "final";

export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Uint8Array;
  writeFile: (path: string, data: Uint8Array) => void;
  exists: (path: string) => boolean;
  fileSize: (path: string) => number;
}

export function defaultIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    readStdin: async () => {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    readFile: (p) => readFileSync(p),
    writeFile: (p, d) => writeFileSync(p, d),
    exists: (p) => existsSync(p),
    fileSize: (p) => statSync(p).size,
  };
}

export class Ctx {
  private cached: LexwareClient | undefined;
  constructor(
    readonly io: Io,
    readonly flags: FlagValues,
  ) {}

  get profile(): string {
    return resolveProfile(this.flags.profile as string | undefined, this.io.env);
  }

  client(): LexwareClient {
    if (!this.cached) {
      const { key } = requireKey(this.profile, this.io.env);
      this.cached = new LexwareClient({
        apiKey: key,
        baseUrl: baseUrl(this.io.env),
        fetch: this.io.fetch,
        sleep: this.io.sleep,
        minIntervalMs: this.io.sleep ? 0 : undefined,
      });
    }
    return this.cached;
  }

  /** Profile flag to carry into suggested follow-up commands. */
  get p(): string {
    return this.flags.profile ? ` --profile ${this.flags.profile}` : "";
  }

  path(p: string): string {
    return resolve(this.io.cwd, p);
  }
}

// ---------- verbs and resources ----------

export interface Verb {
  name: string;
  summary: string;
  usage: string; // without the bin prefix
  tier: Tier | "depends";
  tierNote?: string;
  flags: FlagSpec[];
  examples: string[];
  /** Minimal JSON body shown in `--help` as `minimal_body`. */
  bodyExample?: Record<string, unknown>;
  run: (ctx: Ctx, parsed: ParsedArgs) => Promise<AxiRenderable>;
}

export interface Resource {
  name: string;
  summary: string;
  german?: string;
  verbs: Verb[];
}

export const PROFILE_FLAG: FlagSpec = {
  name: "profile",
  type: "string",
  description: "Key profile, e.g. `test` (default: LEXWARE_PROFILE or `default`)",
};
export const DRY_RUN_FLAG: FlagSpec = {
  name: "dry-run",
  type: "boolean",
  description: "Show the exact request without sending it",
};
export const CONFIRM_FLAG: FlagSpec = {
  name: "confirm",
  type: "boolean",
  description: "Required to send a binding/irreversible request; without it you get a preview",
};
export const FULL_FLAG: FlagSpec = { name: "full", type: "boolean", description: "Show the complete object, no truncation" };

export function flagsFor(verb: Pick<Verb, "tier" | "flags">): FlagSpec[] {
  const extra: FlagSpec[] = [PROFILE_FLAG];
  if (verb.tier !== "read") extra.push(DRY_RUN_FLAG);
  if (verb.tier === "final" || verb.tier === "depends") extra.push(CONFIRM_FLAG);
  return [...verb.flags, ...extra];
}

export function resourceCommand(resource: Resource, io: () => Io) {
  return async (args: string[]): Promise<AxiRenderable> => {
    const verbName = args[0];
    if (!verbName || verbName === "--help") return resourceHelp(resource);
    const verb = resource.verbs.find((v) => v.name === verbName);
    if (!verb) {
      throw new AxiError(`Unknown ${resource.name} command: ${verbName}`, "VALIDATION_ERROR", [
        `Valid: ${resource.verbs.map((v) => v.name).join(", ")}`,
        `Run \`${BIN} ${resource.name} --help\``,
      ]);
    }
    const rest = args.slice(1);
    if (rest.includes("--help")) return verbHelp(resource, verb);
    const parsed = parseArgs(rest, flagsFor(verb), `${BIN} ${verb.usage}`);
    const ctx = new Ctx(io(), parsed.flags);
    return verb.run(ctx, parsed);
  };
}

export function resourceHelp(resource: Resource): AxiStructuredOutput {
  return {
    command: resource.name,
    description: resource.german ? `${resource.summary} (${resource.german})` : resource.summary,
    commands: resource.verbs.map((v) => ({ usage: `${BIN} ${v.usage}`, tier: v.tier, summary: v.summary })),
    help: [`Run \`${BIN} ${resource.name} <command> --help\` for flags and examples`],
  };
}

export function verbHelp(resource: Resource, verb: Verb): AxiStructuredOutput {
  const flags: Record<string, string> = {};
  for (const f of flagsFor(verb)) {
    const bits = [f.description];
    if (f.values) bits.push(`one of: ${f.values.join(", ")}`);
    if (f.default !== undefined) bits.push(`default: ${f.default}`);
    if (f.required) bits.push("required");
    flags[`--${f.name}${f.type === "boolean" ? "" : f.type === "list" ? " <value> (repeatable)" : " <value>"}`] = bits.join("; ");
  }
  const out: AxiStructuredOutput = {
    command: `${resource.name} ${verb.name}`,
    usage: `${BIN} ${verb.usage}`,
    summary: verb.summary,
    tier: verb.tier,
  };
  if (verb.tierNote) out.tier_note = verb.tierNote;
  out.flags = flags;
  if (verb.bodyExample) out.minimal_body = JSON.stringify(verb.bodyExample);
  out.examples = verb.examples.map((e) => `${BIN} ${e}`);
  return out;
}

// ---------- safety gate ----------

export interface Planned {
  method: Method;
  path: string;
  query?: Query;
  body?: unknown;
  file?: string;
}

/**
 * Returns an output object when the request must NOT be sent (dry run, or final tier
 * without --confirm); returns undefined when the caller may send it.
 */
/** True when gate() will stop this call (dry run, or final tier without --confirm). */
export function willPreview(ctx: Ctx, tier: Tier): boolean {
  return ctx.flags["dry-run"] === true || (tier === "final" && ctx.flags.confirm !== true);
}

/**
 * `about` is a one-line, human-readable description of the affected record (who, number,
 * amount, date). Approval UIs show it instead of the raw request.
 */
export function gate(ctx: Ctx, tier: Tier, planned: Planned | Planned[], effect: string, about?: string): AxiStructuredOutput | undefined {
  const requests = Array.isArray(planned) ? planned : [planned];
  const shown = requests.map(compactPlanned);
  const aboutField = about ? { about } : {};
  if (ctx.flags["dry-run"] === true) {
    return {
      dry_run: "nothing was sent",
      ...aboutField,
      tier,
      effect,
      would_send: shown,
      help: tier === "final" ? ["Re-run without --dry-run and with --confirm to send"] : ["Re-run without --dry-run to send"],
    };
  }
  if (tier === "final" && ctx.flags.confirm !== true) {
    return {
      preview: "nothing was sent – this action is binding or irreversible",
      ...aboutField,
      tier,
      effect,
      would_send: shown,
      help: ["Re-run the same command with --confirm to send it"],
    };
  }
  return undefined;
}

function compactPlanned(p: Planned): Record<string, unknown> {
  const out: Record<string, unknown> = { request: `${p.method} /v1${p.path.replace(/^\/v1/, "")}` };
  const query = Object.entries(p.query ?? {}).filter(([, v]) => v !== undefined && v !== "");
  if (query.length > 0) out.query = Object.fromEntries(query);
  if (p.file) out.file = p.file;
  if (p.body !== undefined) out.body = p.body;
  return out;
}

// ---------- body input ----------

export const BODY_FLAGS: FlagSpec[] = [
  { name: "body", type: "string", description: "JSON request body" },
  { name: "body-file", type: "string", description: "Path to a JSON body file, or - for stdin" },
];

export async function readBody(ctx: Ctx, required: boolean): Promise<Record<string, unknown> | undefined> {
  const inline = ctx.flags.body as string | undefined;
  const file = ctx.flags["body-file"] as string | undefined;
  if (inline !== undefined && file !== undefined) {
    throw new AxiError("Use either --body or --body-file, not both", "VALIDATION_ERROR");
  }
  let text: string | undefined;
  let source = "--body";
  if (inline !== undefined) text = inline;
  if (file !== undefined) {
    source = file === "-" ? "stdin" : file;
    text = file === "-" ? await ctx.io.readStdin() : Buffer.from(ctx.io.readFile(ctx.path(file))).toString("utf8");
  }
  if (text === undefined || text.trim() === "") {
    if (required) {
      throw new AxiError("A JSON body is required", "VALIDATION_ERROR", [
        "Pass --body '<json>' or --body-file <path|->; see `--help` for a minimal example",
      ]);
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AxiError(`Body from ${source} is not valid JSON: ${(error as Error).message}`, "VALIDATION_ERROR");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AxiError(`Body from ${source} must be a JSON object`, "VALIDATION_ERROR");
  }
  return parsed as Record<string, unknown>;
}

// ---------- paging ----------

export const PAGING_FLAGS: FlagSpec[] = [
  { name: "page", type: "number", description: "Zero-based page", default: 0 },
  { name: "size", type: "number", description: "Items per page (max 250)", default: 50 },
  { name: "all", type: "boolean", description: "Fetch every page (Lexware caps searches at 10,000 results)" },
];

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
  complete: boolean;
}

interface PagedBody<T> {
  content?: T[];
  totalElements?: number;
  totalPages?: number;
  last?: boolean;
}

export async function fetchPaged<T>(ctx: Ctx, path: string, query: Query): Promise<Page<T>> {
  const size = Math.min(Math.max(Number(ctx.flags.size ?? 50), 1), 250);
  const all = ctx.flags.all === true;
  let page = all ? 0 : Number(ctx.flags.page ?? 0);
  const items: T[] = [];
  let total = 0;
  let pages = 0;
  let last = true;
  for (;;) {
    const res = await ctx.client().json<PagedBody<T>>("GET", path, { query: { ...query, page, size } });
    const body = res.data ?? {};
    items.push(...(body.content ?? []));
    total = body.totalElements ?? items.length;
    pages = body.totalPages ?? 1;
    last = body.last ?? true;
    if (!all || last || items.length >= 10_000) break;
    page++;
  }
  return { items, total, page, size, pages, complete: last };
}

export function countLine(shown: number, total: number): number | string {
  return shown === total ? total : `${shown} of ${total} total`;
}

// ---------- output shaping ----------

const TRUNCATE_AT = 500;

/** Recursively truncates long strings (AXI principle 3) unless --full. */
export function truncateDeep(value: unknown, full: boolean): unknown {
  if (full) return value;
  if (typeof value === "string" && value.length > TRUNCATE_AT) {
    return `${value.slice(0, TRUNCATE_AT)}… (truncated, ${value.length} chars total; use --full)`;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, full));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateDeep(v, full)]));
  }
  return value;
}

/** Drops null/undefined/empty values so TOON output stays small. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export const FIELDS_FLAG: FlagSpec = {
  name: "fields",
  type: "string",
  description: "Comma-separated fields to show instead of the default columns (dot paths allowed, e.g. address.name)",
};

/** Applies --fields to raw items, or the default row mapper. */
export function rows<T>(ctx: Ctx, items: T[], mapper: (item: T) => Record<string, unknown>): Record<string, unknown>[] {
  const fields = (ctx.flags.fields as string | undefined)?.split(",").map((f) => f.trim()).filter(Boolean);
  if (fields && fields.length > 0) {
    return items.map((item) => Object.fromEntries(fields.map((f) => [f, getPath(item, f) ?? null])));
  }
  return items.map((item) => {
    const row = mapper(item);
    // TOON tabular arrays need uniform keys: keep nulls in rows.
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? null]));
  });
}

export function emptyResult(key: string, what: string, extra: AxiStructuredOutput = {}): AxiStructuredOutput {
  return { [key]: `0 ${what} found`, ...extra };
}

export function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function sumMoney(values: unknown[]): number {
  return Math.round(values.reduce<number>((acc, v) => acc + (money(v) ?? 0), 0) * 100) / 100;
}

export function deeplink(kind: string, id: string, mode: "view" | "edit" = "view"): string {
  return `${APP_URL}/permalink/${kind}/${mode}/${id}`;
}

// ---------- files ----------

const UPLOAD_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".xml": "application/xml",
};
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function uploadForm(ctx: Ctx, filePath: string, extra: Record<string, string> = {}): { form: FormData; name: string; bytes: number } {
  const full = ctx.path(filePath);
  if (!ctx.io.exists(full)) throw new AxiError(`File not found: ${filePath}`, "VALIDATION_ERROR");
  const name = basename(full);
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const type = UPLOAD_TYPES[ext];
  if (!type) {
    throw new AxiError(`Unsupported file type: ${ext || "(none)"}`, "VALIDATION_ERROR", ["Lexware accepts pdf, jpg, png and xml"]);
  }
  const bytes = ctx.io.fileSize(full);
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new AxiError(`File is ${bytes} bytes; Lexware accepts at most 5 MB`, "VALIDATION_ERROR", [
      "Downscale or compress the file and upload again",
    ]);
  }
  const form = new FormData();
  form.append("file", new Blob([ctx.io.readFile(full) as Uint8Array<ArrayBuffer>], { type }), name);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return { form, name, bytes };
}

export const OUT_FLAG: FlagSpec = {
  name: "out",
  type: "string",
  description: "Target file or directory (default: current directory, server-suggested filename)",
};

export function saveDownload(ctx: Ctx, bytes: Uint8Array, suggested: string | undefined, fallback: string): string {
  const out = ctx.flags.out as string | undefined;
  const name = (suggested ?? fallback).replace(/[/\\]/g, "_");
  let target = out ? ctx.path(out) : join(ctx.io.cwd, name);
  if (out && ctx.io.exists(target)) {
    try {
      if (statSync(target).isDirectory()) target = join(target, name);
    } catch {
      // keep target
    }
  }
  ctx.io.writeFile(target, bytes);
  return target;
}
