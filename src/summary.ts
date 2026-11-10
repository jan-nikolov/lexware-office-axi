import { compact, deeplink, money } from "./core.js";

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const day = (v: unknown): string | undefined => (typeof v === "string" ? v.slice(0, 10) : undefined);

// ---------- voucherlist rows (used by every list of documents) ----------

export function voucherlistRow(item: unknown, withType: boolean): Obj {
  const v = o(item);
  const row: Obj = { id: v.id, number: v.voucherNumber ?? null };
  if (withType) row.type = v.voucherType;
  return {
    ...row,
    status: v.voucherStatus,
    date: day(v.voucherDate) ?? null,
    due: day(v.dueDate) ?? null,
    contact: v.contactName ?? null,
    total: money(v.totalAmount),
    open: money(v.openAmount),
  };
}

// ---------- sales documents ----------

export function salesSummary(doc: unknown, linkKind: string): Obj {
  const d = o(doc);
  const total = o(d.totalPrice);
  const address = o(d.address);
  const items = Array.isArray(d.lineItems) ? d.lineItems : [];
  const related = Array.isArray(d.relatedVouchers) ? d.relatedVouchers : [];
  const shipping = o(d.shippingConditions);
  const tax = o(d.taxConditions);
  return compact({
    id: d.id,
    number: d.voucherNumber,
    status: d.voucherStatus,
    date: day(d.voucherDate),
    due: day(d.dueDate),
    expires: day(d.expirationDate),
    contact: address.name ?? (address.contactId ? `contact ${address.contactId}` : undefined),
    contactId: address.contactId,
    title: d.title,
    tax_type: tax.taxType,
    shipping: shipping.shippingType ? compact({ type: shipping.shippingType, from: day(shipping.shippingDate), to: day(shipping.shippingEndDate) }) : undefined,
    net: money(total.totalNetAmount),
    tax: money(total.totalTaxAmount),
    gross: money(total.totalGrossAmount),
    line_items: items.map((li) => {
      const l = o(li);
      const price = o(l.unitPrice);
      return {
        name: l.name ?? null,
        qty: l.quantity ?? null,
        unit: l.unitName ?? null,
        net: money(price.netAmount),
        tax_rate: price.taxRatePercentage ?? null,
      };
    }),
    related: related.map((r) => ({ id: o(r).id ?? null, number: o(r).voucherNumber ?? null, type: o(r).voucherType ?? null })),
    introduction: d.introduction,
    remark: d.remark,
    archived: d.archived === true ? true : undefined,
    version: d.version,
    link: typeof d.id === "string" ? deeplink(linkKind, d.id) : undefined,
  });
}

// ---------- bookkeeping vouchers ----------

export function voucherSummary(doc: unknown): Obj {
  const d = o(doc);
  const items = Array.isArray(d.voucherItems) ? d.voucherItems : [];
  return compact({
    id: d.id,
    type: d.type,
    status: d.voucherStatus,
    number: d.voucherNumber,
    date: day(d.voucherDate),
    due: day(d.dueDate),
    contact: d.contactName ?? (d.useCollectiveContact ? "(collective contact)" : undefined),
    contactId: d.contactId,
    tax_type: d.taxType,
    gross: money(d.totalGrossAmount),
    tax: money(d.totalTaxAmount),
    items: items.map((it) => {
      const i = o(it);
      return { amount: money(i.amount), tax: money(i.taxAmount), tax_rate: i.taxRatePercent ?? null, category: i.categoryId ?? null };
    }),
    files: Array.isArray(d.files) ? d.files : undefined,
    remark: d.remark,
    version: d.version,
    link: typeof d.id === "string" ? deeplink("vouchers", d.id) : undefined,
  });
}

/** Fields Lexware needs before a voucher can go from unchecked to open. */
export function missingForBooking(v: Obj): string[] {
  const missing: string[] = [];
  for (const f of ["type", "taxType", "voucherNumber", "voucherDate", "totalGrossAmount", "totalTaxAmount"]) {
    if (v[f] === undefined || v[f] === null || v[f] === "") missing.push(f);
  }
  const items = Array.isArray(v.voucherItems) ? v.voucherItems : [];
  if (items.length === 0) missing.push("voucherItems");
  items.forEach((it, i) => {
    const item = o(it);
    for (const f of ["amount", "taxAmount", "taxRatePercent", "categoryId"]) {
      if (item[f] === undefined || item[f] === null || item[f] === "") missing.push(`voucherItems[${i}].${f}`);
    }
  });
  if (v.useCollectiveContact !== true && !v.contactId) missing.push("contactId or useCollectiveContact=true");
  return missing;
}

// ---------- contacts ----------

export function contactName(c: Obj): string | undefined {
  const company = o(c.company);
  const person = o(c.person);
  if (company.name) return String(company.name);
  const name = [person.firstName, person.lastName].filter(Boolean).join(" ");
  return name || undefined;
}

export function contactRow(item: unknown): Obj {
  const c = o(item);
  const roles = o(c.roles);
  return {
    id: c.id,
    name: contactName(c) ?? null,
    customer_no: o(roles.customer).number ?? null,
    vendor_no: o(roles.vendor).number ?? null,
    archived: c.archived === true,
  };
}

export function contactSummary(item: unknown): Obj {
  const c = o(item);
  const roles = o(c.roles);
  const addresses = o(c.addresses);
  const billing = Array.isArray(addresses.billing) ? o(addresses.billing[0]) : {};
  const emails = o(c.emailAddresses);
  const phones = o(c.phoneNumbers);
  const firstOf = (group: Obj) => {
    for (const list of Object.values(group)) if (Array.isArray(list) && list[0]) return String(list[0]);
    return undefined;
  };
  const company = o(c.company);
  return compact({
    id: c.id,
    name: contactName(c),
    kind: c.company ? "company" : c.person ? "person" : undefined,
    customer_no: o(roles.customer).number,
    vendor_no: o(roles.vendor).number,
    email: firstOf(emails),
    phone: firstOf(phones),
    billing_address: Object.keys(billing).length
      ? [billing.supplement, billing.street, [billing.zip, billing.city].filter(Boolean).join(" "), billing.countryCode].filter(Boolean).join(", ")
      : undefined,
    vat_id: company.vatRegistrationId,
    tax_number: company.taxNumber,
    xrechnung_buyer_reference: o(c.xRechnung).buyerReference,
    note: c.note,
    archived: c.archived === true ? true : undefined,
    version: c.version,
  });
}

// ---------- articles ----------

export function articleRow(item: unknown): Obj {
  const a = o(item);
  const price = o(a.price);
  return {
    id: a.id,
    title: a.title ?? null,
    type: a.type ?? null,
    number: a.articleNumber ?? null,
    net: money(price.netPrice),
    tax_rate: price.taxRate ?? null,
  };
}

export function articleSummary(item: unknown): Obj {
  const a = o(item);
  const price = o(a.price);
  return compact({
    id: a.id,
    title: a.title,
    type: a.type,
    number: a.articleNumber,
    gtin: a.gtin,
    unit: a.unitName,
    leading_price: price.leadingPrice,
    net: money(price.netPrice),
    gross: money(price.grossPrice),
    tax_rate: price.taxRate,
    description: a.description,
    note: a.note,
    archived: a.archived === true ? true : undefined,
    version: a.version,
  });
}

// ---------- payments ----------

export function paymentSummary(item: unknown): Obj {
  const p = o(item);
  const items = Array.isArray(p.paymentItems) ? p.paymentItems : [];
  return compact({
    payment_status: p.paymentStatus,
    voucher_status: p.voucherStatus,
    voucher_type: p.voucherType,
    open: money(p.openAmount),
    currency: p.currency,
    paid_date: day(p.paidDate),
    payments: items.map((it) => {
      const i = o(it);
      return { type: i.paymentItemType ?? null, date: day(i.postingDate) ?? null, amount: money(i.amount) };
    }),
  });
}

// ---------- recurring templates ----------

export function recurringRow(item: unknown): Obj {
  const r = o(item);
  const s = o(r.recurringTemplateSettings);
  return {
    id: r.id,
    title: r.title ?? null,
    contact: o(r.address).name ?? null,
    gross: money(o(r.totalPrice).totalGrossAmount),
    interval: s.executionInterval ?? null,
    next: day(s.nextExecutionDate) ?? null,
    status: s.executionStatus ?? null,
  };
}

export function recurringSummary(item: unknown): Obj {
  const r = o(item);
  const s = o(r.recurringTemplateSettings);
  return compact({
    ...salesSummary(item, "recurring-templates"),
    link: typeof r.id === "string" ? deeplink("recurring-templates", r.id, "edit") : undefined,
    schedule: compact({
      interval: s.executionInterval,
      start: day(s.startDate),
      end: day(s.endDate),
      next: day(s.nextExecutionDate),
      last: day(s.lastExecutionDate),
      status: s.executionStatus,
      finalize_and_email: s.finalize,
      last_failed: s.lastExecutionFailed === true ? true : undefined,
      last_error: s.lastExecutionErrorMessage,
    }),
  });
}
