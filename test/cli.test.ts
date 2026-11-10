import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KEY, UUID, UUID2, on, run, writes } from "./helpers.js";

const profile = on("GET", "/v1/profile", {
  json: { organizationId: UUID, companyName: "Testfirma GmbH", taxType: "net", businessFeatures: ["INVOICING"], created: { userEmail: "owner@example.org", userName: "Owner" } },
});
const page = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  json: { content, totalElements: content.length, totalPages: 1, last: true, number: 0, ...extra },
});

describe("basics", () => {
  it("prints the version", async () => {
    const r = await run(["--version"]);
    expect(r.out.trim()).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  });

  it("lists every resource in --help", async () => {
    const r = await run(["--help"]);
    for (const name of ["invoices", "credit-notes", "quotations", "order-confirmations", "delivery-notes", "dunnings", "down-payment-invoices", "vouchers", "contacts", "articles", "payments", "recurring-templates", "webhooks", "ref", "files", "raw", "auth"]) {
      expect(r.out).toContain(name);
    }
  });

  it("rejects unknown flags with exit 2 and lists valid ones", async () => {
    const r = await run(["invoices", "list", "--bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("code: VALIDATION_ERROR");
    expect(r.out).toContain("--status");
    expect(r.requests).toHaveLength(0);
  });

  it("shows setup guidance instead of failing when no key exists", async () => {
    const r = await run([], [], { env: { LEXWARE_API_KEY: "" } });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("no API key configured");
  });

  it("home view summarises overdue and open invoices and receipts to review", async () => {
    const r = await run([], [
      profile,
      on("GET", "/v1/voucherlist", (req) =>
        req.query.voucherStatus === "overdue"
          ? page([{ openAmount: 100 }, { openAmount: 20.5 }])
          : req.query.voucherStatus === "open"
            ? page([{ openAmount: 100 }, { openAmount: 20.5 }, { openAmount: 9.5 }])
            : page([], { totalElements: 4 }),
      ),
    ]);
    expect(r.out).toContain("company: Testfirma GmbH");
    expect(r.out).toMatch(/overdue:\n\s+count: 2\n\s+open_sum: 120.5/);
    expect(r.out).toContain("vouchers_to_review: 4");
  });

  it("never prints the API key, even in errors", async () => {
    const r = await run(["profile"], [on("GET", "/v1/profile", { status: 401, json: { message: "Unauthorized" } })]);
    expect(r.out).toContain("AUTH_FAILED");
    expect(r.out).not.toContain(KEY);
    expect(r.requests[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("accepts --profile before the command", async () => {
    const env = { LEXWARE_API_KEY: "", LEXWARE_API_KEY_TEST: KEY };
    for (const argv of [["--profile", "test", "profile"], ["--profile=test", "profile"], ["--profile", "test"]]) {
      const r = await run(argv, [profile, on("GET", "/v1/voucherlist", page([]))], { env });
      expect(r.exitCode).toBe(0);
      expect(r.out).toContain("Testfirma GmbH");
      expect(r.requests[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it("profile hides the account owner's personal data", async () => {
    const r = await run(["profile"], [profile]);
    expect(r.out).toContain("Testfirma GmbH");
    expect(r.out).not.toContain("owner@example.org");
  });
});

describe("safety tiers", () => {
  const body = JSON.stringify({ voucherDate: "2026-11-10", address: { contactId: UUID }, lineItems: [] });
  const created = [
    on("POST", "/v1/invoices", { json: { id: UUID } }),
    on("GET", `/v1/invoices/${UUID}`, { json: { id: UUID, voucherNumber: "RE0001", voucherStatus: "draft" } }),
  ];

  it("creates invoices as drafts by default", async () => {
    const r = await run(["invoices", "create", "--body", body], created);
    const post = writes(r)[0]!;
    expect(post.query.finalize).toBeUndefined();
    expect(r.out).toContain("status: draft");
  });

  it("--finalize without --confirm only previews and sends nothing", async () => {
    const r = await run(["invoices", "create", "--body", body, "--finalize"], created);
    expect(writes(r)).toHaveLength(0);
    expect(r.out).toContain("preview: nothing was sent");
    expect(r.out).toContain("--confirm");
    expect(r.exitCode).toBe(0);
  });

  it("--finalize --confirm sends finalize=true", async () => {
    const r = await run(["invoices", "create", "--body", body, "--finalize", "--confirm"], created);
    expect(writes(r)[0]!.query.finalize).toBe("true");
  });

  it("--dry-run sends nothing, even with --confirm", async () => {
    const r = await run(["invoices", "create", "--body", body, "--finalize", "--confirm", "--dry-run"], created);
    expect(writes(r)).toHaveLength(0);
    expect(r.out).toContain("dry_run: nothing was sent");
  });

  it("dunnings require --from", async () => {
    const r = await run(["dunnings", "create", "--body", body]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("--from");
  });

  it("credit note from invoice passes precedingSalesVoucherId", async () => {
    const r = await run(["credit-notes", "create", "--body", body, "--from", UUID2], [
      on("POST", "/v1/credit-notes", { json: { id: UUID } }),
      on("GET", `/v1/credit-notes/${UUID}`, { json: { id: UUID, voucherStatus: "draft" } }),
    ]);
    expect(writes(r)[0]!.query.precedingSalesVoucherId).toBe(UUID2);
  });

  it("raw writes always need --confirm", async () => {
    const r = await run(["raw", "POST", "/v1/contacts", "--body", "{}"]);
    expect(writes(r)).toHaveLength(0);
    expect(r.out).toContain("preview");
    const bad = await run(["raw", "GET", "https://evil.example/v1/x"]);
    expect(bad.exitCode).toBe(2);
  });

  it("article delete is final and idempotent", async () => {
    const preview = await run(["articles", "delete", UUID]);
    expect(writes(preview)).toHaveLength(0);
    const gone = await run(["articles", "delete", UUID, "--confirm"], [on("DELETE", `/v1/articles/${UUID}`, { status: 404, json: {} })]);
    expect(gone.exitCode).toBe(0);
    expect(gone.out).toContain("already gone");
  });

  it("webhooks need --confirm and https", async () => {
    const preview = await run(["webhooks", "create", "--event", "invoice.created", "--url", "https://x.example/h"]);
    expect(writes(preview)).toHaveLength(0);
    const http = await run(["webhooks", "create", "--event", "invoice.created", "--url", "http://x.example/h", "--confirm"]);
    expect(http.exitCode).toBe(2);
  });
});

describe("vouchers", () => {
  const complete = {
    id: UUID,
    version: 3,
    organizationId: UUID2,
    voucherStatus: "unchecked",
    type: "purchaseinvoice",
    taxType: "gross",
    voucherNumber: "R-1",
    voucherDate: "2026-11-10",
    totalGrossAmount: 119,
    totalTaxAmount: 19,
    useCollectiveContact: true,
    voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: UUID2 }],
    files: [UUID2],
  };

  it("create is unchecked by default, even though Lexware would book a status-less voucher", async () => {
    const r = await run(["vouchers", "create", "--body", JSON.stringify({ type: "purchaseinvoice" })], [on("POST", "/v1/vouchers", { json: { id: UUID } })]);
    expect((writes(r)[0]!.body as Record<string, unknown>).voucherStatus).toBe("unchecked");
  });

  it("refuses a body that would book without --book", async () => {
    const r = await run(["vouchers", "create", "--body", JSON.stringify({ voucherStatus: "open" })]);
    expect(r.exitCode).toBe(2);
    expect(writes(r)).toHaveLength(0);
  });

  it("book merges, keeps version and files, strips read-only fields", async () => {
    const r = await run(["vouchers", "book", UUID, "--confirm"], [
      on("GET", `/v1/vouchers/${UUID}`, { json: complete }),
      on("PUT", `/v1/vouchers/${UUID}`, { json: { id: UUID } }),
    ]);
    const put = writes(r)[0]!;
    const sent = put.body as Record<string, unknown>;
    expect(sent.voucherStatus).toBe("open");
    expect(sent.version).toBe(3);
    expect(sent.files).toEqual([UUID2]);
    expect(sent.id).toBeUndefined();
    expect(sent.organizationId).toBeUndefined();
  });

  it("book reports missing fields instead of sending", async () => {
    const r = await run(["vouchers", "book", UUID, "--confirm"], [
      on("GET", `/v1/vouchers/${UUID}`, { json: { ...complete, voucherItems: [], useCollectiveContact: false } }),
    ]);
    expect(writes(r)).toHaveLength(0);
    expect(r.out).toContain("voucherItems");
    expect(r.out).toContain("contactId or useCollectiveContact");
  });

  it("book is a no-op on an already booked voucher", async () => {
    const r = await run(["vouchers", "book", UUID, "--confirm"], [on("GET", `/v1/vouchers/${UUID}`, { json: { ...complete, voucherStatus: "open" } })]);
    expect(writes(r)).toHaveLength(0);
    expect(r.out).toContain("already booked");
    expect(r.exitCode).toBe(0);
  });

  it("upload sends multipart with type=voucher and validates files", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 test");
    const ok = await run(["vouchers", "upload", "beleg.pdf"], [on("POST", "/v1/files", { status: 202, json: { id: UUID2, voucherId: UUID } })], { existing: { "beleg.pdf": pdf } });
    expect(writes(ok)[0]!.body).toEqual({ file: "file:beleg.pdf", type: "voucher" });
    expect(ok.out).toContain(UUID);
    const wrong = await run(["vouchers", "upload", "beleg.docx"], [], { existing: { "beleg.docx": pdf } });
    expect(wrong.exitCode).toBe(2);
    expect(wrong.out).toContain("pdf, jpg, png and xml");
  });
});

describe("lists and search", () => {
  it("refuses overdue combined with other statuses", async () => {
    const r = await run(["invoices", "list", "--status", "overdue,open"]);
    expect(r.exitCode).toBe(2);
    expect(r.requests).toHaveLength(0);
  });

  it("--all follows every page", async () => {
    const r = await run(["invoices", "list", "--all", "--size", "2"], [
      on("GET", "/v1/voucherlist", (req) =>
        req.query.page === "0"
          ? { json: { content: [{ id: "a", totalAmount: 1 }, { id: "b", totalAmount: 2 }], totalElements: 3, totalPages: 2, last: false } }
          : { json: { content: [{ id: "c", totalAmount: 3 }], totalElements: 3, totalPages: 2, last: true } },
      ),
    ]);
    expect(r.requests).toHaveLength(2);
    expect(r.out).toContain("count: 3");
    expect(r.out).toContain("total: 6");
  });

  it("says when there are more results", async () => {
    const r = await run(["invoices", "list", "--size", "1"], [on("GET", "/v1/voucherlist", { json: { content: [{ id: "a" }], totalElements: 5, totalPages: 5, last: false } })]);
    expect(r.out).toContain("1 of 5 total");
    expect(r.out).toContain("--page 1");
  });

  it("states empty results explicitly", async () => {
    const r = await run(["invoices", "list"], [on("GET", "/v1/voucherlist", page([]))]);
    expect(r.out).toContain("0 invoices found");
    expect(r.exitCode).toBe(0);
  });

  it("escapes & < > in contact searches as the Lexware FAQ requires", async () => {
    const r = await run(["contacts", "list", "--name", "Johnson & Partner"], [on("GET", "/v1/contacts", page([]))]);
    expect(r.requests[0]!.query.name).toBe("Johnson &amp; Partner");
  });

  it("--fields picks raw paths", async () => {
    const r = await run(["invoices", "list", "--fields", "voucherNumber,contactName"], [on("GET", "/v1/voucherlist", page([{ voucherNumber: "RE1", contactName: "X", id: "a" }]))]);
    expect(r.out).toContain("{voucherNumber,contactName}");
  });
});

describe("transport", () => {
  it("retries 429 for writes (Lexware did not perform them)", async () => {
    let n = 0;
    const r = await run(["contacts", "create", "--body", "{}"], [
      on("POST", "/v1/contacts", () => (++n === 1 ? { status: 429, json: {} } : { json: { id: UUID } })),
    ]);
    expect(writes(r)).toHaveLength(2);
    expect(r.exitCode).toBe(0);
  });

  it("never retries a write after a 5xx and reports an unknown outcome", async () => {
    const r = await run(["contacts", "create", "--body", "{}"], [on("POST", "/v1/contacts", { status: 504, json: {} })]);
    expect(writes(r)).toHaveLength(1);
    expect(r.out).toContain("WRITE_OUTCOME_UNKNOWN");
  });

  it("retries reads after 503", async () => {
    let n = 0;
    const r = await run(["profile"], [on("GET", "/v1/profile", () => (++n === 1 ? { status: 503, json: {} } : { json: { companyName: "X" } }))]);
    expect(r.requests).toHaveLength(2);
    expect(r.out).toContain("company: X");
  });

  it("maps 406 validation details from both error shapes", async () => {
    const regular = await run(["contacts", "create", "--body", "{}"], [
      on("POST", "/v1/contacts", { status: 406, json: { message: "x", details: [{ field: "company.name", message: "darf nicht leer sein" }] } }),
    ]);
    expect(regular.out).toContain("company.name: darf nicht leer sein");
    const legacy = await run(["contacts", "create", "--body", "{}"], [
      on("POST", "/v1/contacts", { status: 406, json: { IssueList: [{ source: "roles", i18nKey: "missing_entity" }] } }),
    ]);
    expect(legacy.out).toContain("roles: missing_entity");
  });

  it("downloads documents with the server-suggested filename", async () => {
    const r = await run(["invoices", "file", UUID], [
      on("GET", `/v1/invoices/${UUID}/file`, { bytes: new Uint8Array([37, 80, 68, 70]), headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Rechnung_RE0001.pdf"' } }),
    ]);
    expect(r.out).toContain("Rechnung_RE0001.pdf");
    expect([...r.files.keys()].some((k) => k.endsWith("Rechnung_RE0001.pdf"))).toBe(true);
  });

  it("explains that drafts have no document", async () => {
    const r = await run(["invoices", "file", UUID], [on("GET", `/v1/invoices/${UUID}/file`, { status: 409, json: {} })]);
    expect(r.out).toContain("DRAFT_HAS_NO_DOCUMENT");
  });
});

describe("auth", () => {
  it("reads the key from stdin, verifies it and stores it with mode 0600", async () => {
    const r = await run(["auth", "set", "--profile", "test"], [profile], { stdin: "secret-from-stdin\n" });
    expect(r.out).toContain("company: Testfirma GmbH");
    expect(r.out).not.toContain("secret-from-stdin");
    const file = /\n\s+file: (.+)/.exec(r.out)![1]!.trim();
    expect(readFileSync(file, "utf8").trim()).toBe("secret-from-stdin");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
  });

  it("uses LEXWARE_API_KEY_<PROFILE> for named profiles", async () => {
    const r = await run(["profile", "--profile", "test"], [profile], { env: { LEXWARE_API_KEY: "", LEXWARE_API_KEY_TEST: "k2" } });
    expect(r.requests[0]!.headers.Authorization).toBe("Bearer k2");
  });
});
