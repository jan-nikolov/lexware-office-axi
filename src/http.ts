import { AxiError } from "axi-sdk-js";

export type Method = "GET" | "POST" | "PUT" | "DELETE";
export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  form?: FormData;
  accept?: string;
}

export interface JsonResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

export interface BinaryResponse {
  status: number;
  bytes: Uint8Array;
  contentType: string;
  filename: string | undefined;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between requests. The API allows 2 requests/second across all endpoints. */
  minIntervalMs?: number;
  timeoutMs?: number;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/**
 * Thin Lexware Office API client.
 * - Paces itself under the 2 req/s limit.
 * - 429 means "not performed", so every method retries it with backoff.
 * - Other transient failures (5xx, network, timeout) are retried for GET only.
 *   For writes the outcome is unknown, so it reports WRITE_OUTCOME_UNKNOWN instead of
 *   risking a duplicate invoice or voucher.
 * - The API key never appears in errors or output.
 */
export class LexwareClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minInterval: number;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;
  requestCount = 0;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.minInterval = options.minIntervalMs ?? 520;
    this.timeoutMs = options.timeoutMs ?? 35_000;
  }

  url(path: string, query?: Query): string {
    const url = new URL(this.options.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async json<T = unknown>(method: Method, path: string, opts: RequestOptions = {}): Promise<JsonResponse<T>> {
    const res = await this.send(method, path, { ...opts, accept: opts.accept ?? "application/json" });
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  async binary(path: string, accept = "*/*"): Promise<BinaryResponse> {
    const res = await this.send("GET", path, { accept });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      bytes,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      filename: filenameFrom(res.headers.get("content-disposition")),
    };
  }

  private async send(method: Method, path: string, opts: RequestOptions): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Response;
      try {
        res = await this.fetchOnce(method, path, opts);
      } catch (error) {
        if (method === "GET" && attempt < RETRY_DELAYS_MS.length - 1) {
          await this.sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        if (method !== "GET") {
          throw writeOutcomeUnknown(method, path, describeNetworkError(error));
        }
        throw new AxiError(`Network error calling Lexware: ${describeNetworkError(error)}`, "NETWORK_ERROR", [
          "Check connectivity and https://status.lexware.de, then retry",
        ]);
      }
      if (res.ok) return res;

      const retryable429 = res.status === 429 && attempt < RETRY_DELAYS_MS.length;
      const retryableRead = method === "GET" && [500, 502, 503, 504].includes(res.status) && attempt < 2;
      if (retryable429 || retryableRead) {
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      const text = await res.text().catch(() => "");
      if (method !== "GET" && [500, 502, 504].includes(res.status)) {
        throw writeOutcomeUnknown(method, path, `HTTP ${res.status}`);
      }
      throw apiError(res.status, text, method, path);
    }
  }

  private async fetchOnce(method: Method, path: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: opts.accept ?? "application/json",
      "User-Agent": "lexware-office-axi",
    };
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    this.requestCount++;
    return this.fetchImpl(this.url(path, opts.query), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minInterval - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "request timed out";
    return error.message;
  }
  return String(error);
}

function writeOutcomeUnknown(method: Method, path: string, reason: string): AxiError {
  return new AxiError(
    `${method} ${path} failed (${reason}); Lexware may or may not have applied it`,
    "WRITE_OUTCOME_UNKNOWN",
    ["Do not resend blindly: check with the matching `list` or `get` command first, then retry only if nothing was created"],
  );
}

export function filenameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim();
}

interface RegularError {
  message?: string;
  details?: Array<{ violation?: string; field?: string; message?: string }>;
}
interface LegacyError {
  IssueList?: Array<{ i18nKey?: string; source?: string; type?: string; additionalData?: unknown }>;
}

/** Maps Lexware's two error shapes (regular and legacy IssueList) to one structured AXI error. */
export function apiError(status: number, text: string, method: Method, path: string): AxiError {
  let body: (RegularError & LegacyError) | undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const problems: string[] = [];
  for (const d of body?.details ?? []) {
    problems.push([d.field, d.message ?? d.violation].filter(Boolean).join(": "));
  }
  for (const issue of body?.IssueList ?? []) {
    problems.push([issue.source, issue.i18nKey ?? issue.type].filter(Boolean).join(": "));
  }
  const detail = problems.length > 0 ? ` – ${problems.slice(0, 5).join("; ")}` : body?.message ? ` – ${body.message}` : "";
  const where = `${method} ${path}`;
  switch (status) {
    case 400:
      return new AxiError(`Bad request for ${where}${detail}`, "API_BAD_REQUEST", ["Fix the parameters or body and retry"]);
    case 401:
      return new AxiError("Lexware rejected the API key (401)", "AUTH_FAILED", [
        "Check the key for this profile with `lexware-office-axi auth status --live`",
        "If the key is right, check https://status.lexware.de",
      ]);
    case 402:
      return new AxiError("Lexware contract issue (402): the account may lack this feature", "PAYMENT_REQUIRED", [
        "Run `lexware-office-axi profile` to see the account's businessFeatures",
      ]);
    case 403:
      return new AxiError(`Not allowed: ${where} (403)`, "FORBIDDEN", [
        "The key may lack the scope for this endpoint, or the path/method is wrong",
      ]);
    case 404:
      return new AxiError(`Not found: ${where}`, "NOT_FOUND", ["Check the id with the matching `list` command"]);
    case 406:
      return new AxiError(`Lexware rejected the request${detail}`, "API_VALIDATION", [
        "Fix the listed fields; see `<resource> <verb> --help` for a minimal body",
      ]);
    case 409:
      return new AxiError(`Conflict for ${where}${detail}`, "CONFLICT", [
        "The resource changed meanwhile (version) or is in a state that forbids this; re-read it with `get` and retry",
      ]);
    case 415:
      return new AxiError(`Unsupported media type for ${where}`, "UNSUPPORTED_MEDIA_TYPE");
    case 429:
      return new AxiError("Rate limit still exceeded after retries", "RATE_LIMITED", ["Wait a minute, then retry"]);
    default:
      return new AxiError(`Lexware error ${status} for ${where}${detail}`, "API_ERROR", [
        "Check https://status.lexware.de; retry later",
      ]);
  }
}

/**
 * The FAQ requires `&`, `<`, `>` in search strings (contacts name/email, voucherNumber)
 * to be HTML-escaped before URL encoding.
 */
export function escapeSearch(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
