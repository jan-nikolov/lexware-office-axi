import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import type { Io } from "../src/core.js";

export const KEY = "test-secret-key-0123456789";
export const UUID = "11111111-2222-4333-8444-555555555555";
export const UUID2 = "66666666-7777-4888-9999-000000000000";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export type Reply = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; headers?: Record<string, string> };
export type Route = (req: Recorded) => Reply | undefined;

export interface RunResult {
  out: string;
  exitCode: number;
  requests: Recorded[];
  files: Map<string, Uint8Array>;
}

/** Runs the CLI in-process against a fake Lexware API. Routes are tried in order; unmatched requests return 404. */
export async function run(argv: string[], routes: Route[] = [], opts: { env?: Record<string, string>; stdin?: string; existing?: Record<string, Uint8Array> } = {}): Promise<RunResult> {
  const requests: Recorded[] = [];
  const files = new Map<string, Uint8Array>(Object.entries(opts.existing ?? {}));
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).name}`]));
    const req: Recorded = { method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers };
    requests.push(req);
    for (const route of routes) {
      const reply = route(req);
      if (reply) {
        const h = new Headers(reply.headers ?? {});
        if (reply.bytes) return new Response(reply.bytes as Uint8Array<ArrayBuffer>, { status: reply.status ?? 200, headers: h });
        if (reply.json !== undefined) {
          h.set("content-type", "application/json");
          return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: h });
        }
        return new Response(reply.text ?? null, { status: reply.status ?? 200, headers: h });
      }
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof fetch;

  const cwd = mkdtempSync(join(tmpdir(), "lxaxi-"));
  const io: Io = {
    env: { LEXWARE_API_KEY: KEY, LEXWARE_API_BASE_URL: "https://api.test", LEXWARE_OFFICE_AXI_CONFIG_DIR: join(cwd, "config"), ...opts.env },
    cwd,
    fetch: fakeFetch,
    sleep: async () => undefined,
    readStdin: async () => opts.stdin ?? "",
    readFile: (p) => {
      const f = files.get(p) ?? files.get(p.replace(`${cwd}/`, ""));
      if (!f) throw new Error(`no fake file ${p}`);
      return f;
    },
    writeFile: (p, d) => void files.set(p, d),
    exists: (p) => files.has(p) || files.has(p.replace(`${cwd}/`, "")),
    fileSize: (p) => (files.get(p) ?? files.get(p.replace(`${cwd}/`, "")) ?? new Uint8Array()).length,
  };

  let out = "";
  const prevExit = process.exitCode;
  process.exitCode = 0;
  await main(argv, io, { write: (c: string) => void (out += c) });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = prevExit;
  return { out, exitCode, requests, files };
}

export const on =
  (method: string, path: string | RegExp, reply: Reply | ((req: Recorded) => Reply)): Route =>
  (req) => {
    const pathOk = typeof path === "string" ? req.path === path : path.test(req.path);
    if (req.method !== method || !pathOk) return undefined;
    return typeof reply === "function" ? reply(req) : reply;
  };

export const writes = (r: RunResult) => r.requests.filter((q) => q.method !== "GET");
