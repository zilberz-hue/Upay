/* uPay reports a charge (ipn=1, server to server) and the customer is sent back here.
   The address carries the charge id and its secret token; neither is proof of payment.
   With an API key the transaction is asked from uPay itself and the invoice follows
   by itself. Without one, the report is written down and the owner confirms it. */
import { charges, claims, loadSettings, same, round2, upayCreds, upayTransaction, issueInvoice } from "../lib/common.mjs";

const html = (msg) => new Response(
  `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>תשלום</title></head><body style="font-family:system-ui,Arial,sans-serif;text-align:center;padding:60px 16px"><h2>${msg}</h2></body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export default async (req) => {
  await loadSettings();
  const url = new URL(req.url);
  const q = Object.fromEntries(url.searchParams);
  if (req.method === "POST") {
    const raw = await req.text();
    try { Object.assign(q, JSON.parse(raw)); } catch { try { for (const [a, b] of new URLSearchParams(raw)) if (!(a in q)) q[a] = b; } catch {} }
  }
  const ipn = String(q.ipn || "") === "1";
  const done = (msg) => (ipn ? new Response("OK") : html(msg));

  const id = String(q.c || "");
  const store = charges();
  const c = id ? await store.get(id, { type: "json" }) : null;
  if (!c || !same(c.token, q.k)) return done("קישור לא תקין");
  if (c.status === "paid") return done("התשלום התקבל. תודה!");

  const status = String(q.providererrordescription || q.status || "").toUpperCase();
  const trx = String(q.transactionid || q.cashierid || "").slice(0, 60);
  if (q.errormessage || status !== "SUCCESS" || !trx) {
    await store.setJSON(id, { ...c, status: c.status === "reported" ? c.status : "failed", note: "uPay: התשלום לא הושלם", failedAt: Date.now() });
    return done("התשלום לא הושלם.");
  }

  const creds = upayCreds();
  if (!creds || !creds.key) {
    const sum = Number(q.amount);
    await store.setJSON(id, { ...c, status: "reported", report: { trx, sum: Number.isFinite(sum) ? sum : null, at: Date.now() },
      note: `uPay דיווחה על תשלום${Number.isFinite(sum) && sum > 0 ? " של ₪" + sum : ""} · עסקה ${trx}. לאשר מול uPay` });
    return done("התשלום התקבל. תודה!");
  }

  let t = null;
  try { t = await upayTransaction(creds, trx); } catch {}
  const st = String(t?.transferstatus || "").toUpperCase();
  const desc = String((t && (t.productdescription ?? t.paymentdetails)) || "");
  const paid = Number(t?.amount);
  if (!t || !["S", "A"].includes(st) || !desc.includes(id)) {
    await store.setJSON(id, { ...c, note: `uPay דיווחה על עסקה ${trx} אך האימות מול uPay נכשל. לבדוק בממשק uPay.` });
    return done("התשלום בבדיקה.");
  }
  if (!(paid + 0.5 >= c.total)) {
    await store.setJSON(id, { ...c, note: `שולמו ₪${paid} מתוך ₪${c.total} · עסקה ${trx}` });
    return done("התשלום חלקי. נחזור אליכם.");
  }
  /* uPay calls twice (its notice and the customer's return): one wins. */
  const won = await claims().set(id + ":paid", String(Date.now()), { onlyIfNew: true });
  if (won.modified) {
    await store.setJSON(id, { ...c, status: "paid", paidAt: Date.now(), payRef: trx, paidSum: round2(paid) });
    const out = await issueInvoice(id);
    if (!out.ok) console.warn("invoice for", id, "failed:", out.reason);
  }
  return done("התשלום התקבל. תודה!");
};
