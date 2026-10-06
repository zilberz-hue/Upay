/* Shared by every function: storage, sign-in, uPay and iCount. */
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;
export const siteUrl = () => String(process.env.SITE_URL || process.env.URL || "").replace(/\/+$/, "");
export const charges = () => getStore({ name: "charges", consistency: "strong" });
export const items = () => getStore({ name: "items", consistency: "strong" });
export const claims = () => getStore({ name: "claims", consistency: "strong" });

/* ---------------- sign-in: one password, signed 30-day token ---------------- */
const secret = () => crypto.createHash("sha256").update("charge-desk|" + String(process.env.ADMIN_PASSWORD || "")).digest();
const b64 = (b) => Buffer.from(b).toString("base64url");
export const same = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export function makeToken() {
  const p = b64(JSON.stringify({ exp: Date.now() + 30 * 864e5 }));
  return p + "." + crypto.createHmac("sha256", secret()).update(p).digest("base64url");
}
export function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const t = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [p, sig] = t.split(".");
  if (!p || !sig) return false;
  if (!same(sig, crypto.createHmac("sha256", secret()).update(p).digest("base64url"))) return false;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()).exp > Date.now(); } catch { return false; }
}

/* ---------------- uPay ---------------- */
const UPAY_API = "https://app.upay.co.il/API6/clientsecure/json.php";
export const UPAY_FORM = "https://app.upay.co.il/API6/clientsecure/redirectpage.php";
export function upayCreds() {
  const email = String(process.env.UPAY_EMAIL || "").trim();
  const key = String(process.env.UPAY_API_KEY || "").trim();
  return email ? { email, key } : null;
}
async function upayCall(c, request) {
  const header = { refername: "UPAY", livesystem: 1, language: "HE" };
  const msgs = [
    { header, request: { mainaction: "CONNECTION", minoraction: "LOGIN", encoding: "json", parameters: { email: c.email, key: c.key } } },
    { header, request: { encoding: "json", ...request } },
  ];
  const res = await fetch(UPAY_API, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ msgs: JSON.stringify(msgs) }).toString() });
  try { return JSON.parse(await res.text()); } catch { return null; }
}
export async function upayCreatePage(c, { amount, description, returnUrl, ipnUrl, phone, email }) {
  const cell = String(phone || "").replace(/[^\d+]/g, "");
  const transfer = {
    email: c.email, commissionreduction: 0, amount, currency: "NIS", maxpayments: 1,
    paymentdate: new Date().toISOString().slice(0, 10), productdescription: description,
    returnurl: returnUrl, ipnurl: ipnUrl,
    ...(/^(05|\+9725)/.test(cell) ? { cellphonenotify: cell.replace(/^\+972/, "0") } : {}),
    ...(email ? { emailnotify: String(email).slice(0, 120) } : {}),
  };
  const res = await upayCall(c, { mainaction: "CASHIER", minoraction: "REDIRECTDEPOSITCREDITCARDTRANSFER", numbertemplate: 15,
    parameters: { transfers: [transfer], foreign: "0", key: c.key, cardreader: "0", creditcardcompanytype: "ISR", creditcardtype: "PR" } });
  const url = res?.results?.[1]?.result?.transactions?.[0]?.url;
  return url && /^https:\/\//i.test(url) ? url : "";
}
export async function upayTransaction(c, trx) {
  const res = await upayCall(c, { mainaction: "TRANSACTIONSINFO", minoraction: "GETTRANSACTIONS", parameters: { cashierids: [trx] } });
  return res?.results?.[1]?.result?.sendertransactions?.[0] || null;
}
/* uPay's own payment button, for an account connected by email alone. */
export function upayFormFields(c, { amount, description, returnUrl, ipnUrl, phone, email }) {
  const cell = String(phone || "").replace(/[^\d+]/g, "");
  return {
    email: c.email, amount: Number(amount).toFixed(2), returnurl: returnUrl, ipnurl: ipnUrl,
    ...(email ? { emailnotify: String(email).slice(0, 120) } : {}),
    ...(/^(05|\+9725)/.test(cell) ? { cellphonenotify: cell.replace(/^\+972/, "0") } : {}),
    comment: String(description).slice(0, 120), paymentdetails: String(description).slice(0, 120),
    maxpayments: "1", livesystem: "1", commissionreduction: "",
    createinvoiceandreceipt: "0", createinvoice: "0", createreceipt: "0",
    refername: "UPAY", lang: "HE", currency: "NIS",
  };
}

/* ---------------- iCount ---------------- */
const IC_ROOTS = ["https://api.icount.co.il/api/v3.php", "https://api.icount.co.il/api/v3.0"];
export const vatRate = () => {
  const v = process.env.ICOUNT_VAT_RATE;
  return v === undefined || v === "" ? 18 : Number(v) || 0;
};
/* iCount reads a unit price as BEFORE VAT and adds VAT on top, so a price that
   includes VAT is divided first, to the figure that comes back to it exactly. */
export function netOf(gross, rate) {
  if (rate <= 0) return round2(gross);
  const up = (n) => round2(n * (1 + rate / 100));
  const base = round2(gross / (1 + rate / 100));
  if (up(base) === round2(gross)) return base;
  for (const step of [-0.01, 0.01, -0.02, 0.02]) { const t = round2(base + step); if (up(t) === round2(gross)) return t; }
  let down = base;
  while (up(down) > round2(gross)) down = round2(down - 0.01);
  return down;
}
export const icountReady = () => Boolean(process.env.ICOUNT_CID && process.env.ICOUNT_USER && process.env.ICOUNT_PASS);

/* One tax invoice-receipt (invrec) with a line per item, paid by card. */
export async function icountInvoice(c) {
  if (!icountReady()) return { ok: false, reason: "iCount לא מחובר: חסרים מזהה חברה, משתמש או סיסמה ב-Netlify." };
  let base = "", sid = "", why = "";
  for (const root of IC_ROOTS) {
    try {
      const r = await fetch(`${root}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cid: process.env.ICOUNT_CID, user: process.env.ICOUNT_USER, pass: process.env.ICOUNT_PASS }) });
      const d = await r.json().catch(() => ({}));
      if (d?.sid) { base = root; sid = d.sid; break; }
      why = d?.reason || d?.error_description || "";
    } catch { why = "לא הצלחנו להגיע ל-iCount"; }
  }
  if (!sid) return { ok: false, reason: "ההתחברות ל-iCount נכשלה. בדקו מזהה חברה, משתמש וסיסמה." + (why ? ` (${String(why).slice(0, 120)})` : "") };

  const rate = vatRate();
  const lines = (c.lines || []).map((l) => ({
    description: String(l.name || "שירות").slice(0, 120), quantity: Number(l.qty) || 1, unitprice: netOf(Number(l.price) || 0, rate),
  }));
  /* The payment is recorded as the document's own total (an agora below the
     charge at most): a payment that disagrees with the document is refused. */
  const sum = round2(lines.reduce((a, l) => a + l.unitprice * l.quantity, 0) * (1 + rate / 100));
  const date = new Date().toISOString().slice(0, 10);
  const r = await fetch(`${base}/doc/create`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sid, doctype: "invrec", client_name: c.name || "",
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || "") ? c.email : undefined,
      items: lines, cc: { sum, date, num_of_payments: 1 },
      hwc: c.id ? `חיוב ${c.id}` : undefined,
      send_email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || "") ? 1 : 0,
    }) });
  const d = await r.json().catch(() => ({}));
  if (!d?.status) return { ok: false, reason: d?.reason || "ההפקה ב-iCount נכשלה.", detail: ((d?.error_description || "") + " · " + JSON.stringify(d)).slice(0, 300) };
  return { ok: true, number: String(d.docnum || d.doc_number || ""), url: d.doc_url || "" };
}

/* ---------------- the invoice for a paid charge, once ---------------- */
export async function issueInvoice(id) {
  const store = charges();
  const c = await store.get(id, { type: "json" });
  if (!c) return { ok: false, reason: "החיוב לא נמצא" };
  if (c.status !== "paid") return { ok: false, reason: "החיוב טרם שולם" };
  if (c.invoiceNo) return { ok: true, number: c.invoiceNo, already: true };
  const won = await claims().set(id + ":invoice", String(Date.now()), { onlyIfNew: true });
  if (!won.modified) return { ok: false, reason: "הפקה כבר מתבצעת" };
  let out;
  try { out = await icountInvoice({ ...c, id }); } catch { out = { ok: false, reason: "iCount לא ענה" }; }
  const fresh = (await store.get(id, { type: "json" })) || c;
  if (out.ok) {
    await store.setJSON(id, { ...fresh, invoiceNo: out.number, invoiceUrl: out.url || "", invoicedAt: Date.now(), invoiceError: "" });
  } else {
    await store.setJSON(id, { ...fresh, invoiceError: String(out.reason || "").slice(0, 200) });
    await claims().delete(id + ":invoice");
  }
  return out;
}
