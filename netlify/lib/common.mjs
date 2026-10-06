/* Shared by every function: storage, sign-in, uPay and iCount. */
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;
export const siteUrl = () => String(process.env.SITE_URL || process.env.URL || "").replace(/\/+$/, "");
export const charges = () => getStore({ name: "charges", consistency: "strong" });
export const items = () => getStore({ name: "items", consistency: "strong" });
export const customers = () => getStore({ name: "customers", consistency: "strong" });
export const combos = () => getStore({ name: "combos", consistency: "strong" });
export const claims = () => getStore({ name: "claims", consistency: "strong" });

/* ---------------- settings: typed once on the page, kept on the server ----------------
   A value set in Netlify's environment wins; otherwise the one saved from the
   Settings tab is used. Secrets are written here and never sent back: the page
   only ever sees a masked hint. */
export const SETTING_KEYS = ["UPAY_EMAIL", "ICOUNT_CID", "ICOUNT_USER", "ICOUNT_PASS", "ICOUNT_VAT_RATE", "ICOUNT_BANK_ACCOUNT"];
export const SECRET_KEYS = new Set(["ICOUNT_PASS"]);
const settingsStore = () => getStore({ name: "settings", consistency: "strong" });
const FROM_NETLIFY = {};
for (const k of [...SETTING_KEYS, "ADMIN_PASSWORD"]) FROM_NETLIFY[k] = process.env[k];
let stored = {}, adminHash = "", loadedAt = 0;

export async function loadSettings(force = false) {
  if (!force && Date.now() - loadedAt < 5000) return stored;
  const st = settingsStore();
  stored = (await st.get("all", { type: "json" })) || {};
  adminHash = ((await st.get("admin", { type: "json" })) || {}).hash || "";
  loadedAt = Date.now();
  for (const k of SETTING_KEYS) {
    if (FROM_NETLIFY[k]) process.env[k] = FROM_NETLIFY[k];
    else if (stored[k]) process.env[k] = String(stored[k]);
    else delete process.env[k];
  }
  return stored;
}
export async function saveSettings(values, clear = []) {
  const st = settingsStore();
  const cur = (await st.get("all", { type: "json" })) || {};
  for (const k of SETTING_KEYS) if (values && values[k] != null && String(values[k]).trim() !== "") cur[k] = String(values[k]).trim();
  for (const k of clear) if (SETTING_KEYS.includes(k)) delete cur[k];
  await st.setJSON("all", cur);
  await loadSettings(true);
}
export function describeSettings() {
  const out = {};
  for (const k of SETTING_KEYS) {
    const fromNetlify = Boolean(FROM_NETLIFY[k]);
    const v = fromNetlify ? FROM_NETLIFY[k] : stored[k] || "";
    out[k] = { set: Boolean(v), source: fromNetlify ? "netlify" : v ? "page" : null,
      hint: !v ? "" : SECRET_KEYS.has(k) ? "••••" + String(v).slice(-4) : String(v) };
  }
  return out;
}

/* ---------------- sign-in: one password, signed 30-day token ----------------
   The password is either ADMIN_PASSWORD in Netlify, or the one created on the
   page the first time it is opened (kept only as a salted hash). */
const scryptHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
export const hasPassword = () => Boolean(FROM_NETLIFY.ADMIN_PASSWORD || adminHash);
export const passwordFromNetlify = () => Boolean(FROM_NETLIFY.ADMIN_PASSWORD);
export function checkPassword(pw) {
  if (FROM_NETLIFY.ADMIN_PASSWORD) return same(pw, FROM_NETLIFY.ADMIN_PASSWORD);
  if (!adminHash) return false;
  const [salt, h] = adminHash.split(":");
  return same(scryptHash(pw, salt), h);
}
/* The first password can be created once: the claim is atomic, so two people
   opening a fresh site at the same moment cannot both win. */
export async function createFirstPassword(pw) {
  if (hasPassword()) return false;
  const salt = crypto.randomBytes(16).toString("hex");
  const r = await settingsStore().setJSON("admin", { hash: salt + ":" + scryptHash(pw, salt) }, { onlyIfNew: true });
  await loadSettings(true);
  return r.modified !== false;
}
export async function changePassword(pw) {
  if (FROM_NETLIFY.ADMIN_PASSWORD) return false;
  const salt = crypto.randomBytes(16).toString("hex");
  await settingsStore().setJSON("admin", { hash: salt + ":" + scryptHash(pw, salt) });
  await loadSettings(true);
  return true;
}
const secret = () => crypto.createHash("sha256").update("charge-desk|" + String(FROM_NETLIFY.ADMIN_PASSWORD || adminHash || "")).digest();
const b64 = (b) => Buffer.from(b).toString("base64url");
export const same = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export function makeToken() {
  const p = b64(JSON.stringify({ exp: Date.now() + 30 * 864e5 }));
  return p + "." + crypto.createHmac("sha256", secret()).update(p).digest("base64url");
}
export async function isAdmin(req) {
  await loadSettings();
  if (!hasPassword()) return false;
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

/* How the money arrived, as iCount wants it: each method an object at the root
   of the request. A card is the default (a uPay charge). Bit, PayBox and cash
   settle like cash and are recorded as cash (the document remark says which).
   A bank transfer needs the internal id of the bank account as set up in
   iCount: without it iCount takes the document and drops the payment, so it is
   refused here instead. */
function payPart(method, sum, date, last4) {
  if (method === "bank") {
    const account = String(process.env.ICOUNT_BANK_ACCOUNT || "").trim();
    if (!account) return { __missing: "להעברה בנקאית חסר מזהה חשבון הבנק ב-iCount. אפשר להזין אותו בלשונית הגדרות." };
    return { bank_transfer: { sum, date, account: Number(account) || account } };
  }
  if (method === "cash" || method === "bit" || method === "paybox") return { cash: { sum } };
  /* The last four digits of the card travel with the payment: the tax
     authority expects them on a card receipt. */
  return { cc: { sum, date, num_of_payments: 1, ...(/^\d{4}$/.test(last4 || "") ? { card_number: last4 } : {}) } };
}

/* One tax invoice-receipt (invrec) with a line per item, paid by card. */
export async function icountInvoice(c) {
  if (!icountReady()) return { ok: false, reason: "iCount לא מחובר: חסרים מזהה חברה, משתמש או סיסמה. אפשר להזין בלשונית הגדרות." };
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
  const pay = payPart(c.method, sum, date, c.last4);
  if (pay.__missing) return { ok: false, reason: pay.__missing };
  const r = await fetch(`${base}/doc/create`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sid, doctype: "invrec", client_name: c.name || "",
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || "") ? c.email : undefined,
      items: lines, ...pay,
      hwc: c.id ? `חיוב ${c.id}${c.methodLabel ? ` · ${c.methodLabel}` : ""}${(!c.method || c.method === "cc") && /^\d{4}$/.test(c.last4 || "") ? ` · כרטיס ****${c.last4}` : ""}` : undefined,
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

/* ---------------- the page learns: items and customers are remembered as they are used ---------------- */
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

/* Every item typed on a charge is kept with its latest price, so next time it is
   one pick away. A known item gets the newest price and one more use. */
export async function learnItems(lines) {
  const store = items();
  const list = (await store.get("all", { type: "json" })) || [];
  for (const l of lines) {
    const hit = list.find((i) => norm(i.name) === norm(l.name));
    if (hit) { hit.price = l.price; hit.uses = (hit.uses || 0) + 1; hit.last = Date.now(); if (l.sku && !hit.sku) hit.sku = l.sku; }
    else list.push({ name: l.name, sku: l.sku || "", price: l.price, uses: 1, last: Date.now() });
  }
  await store.setJSON("all", list.slice(0, 5000));
}

/* The same for the people charged: name, mobile and email. */
export async function learnCustomer({ name, phone, email }) {
  if (!norm(name)) return;
  const store = customers();
  const list = (await store.get("all", { type: "json" })) || [];
  const hit = list.find((c) => norm(c.name) === norm(name));
  if (hit) { if (phone) hit.phone = phone; if (email) hit.email = email; hit.uses = (hit.uses || 0) + 1; hit.last = Date.now(); }
  else list.push({ name: String(name).trim(), phone: phone || "", email: email || "", uses: 1, last: Date.now() });
  await store.setJSON("all", list.slice(0, 5000));
}
