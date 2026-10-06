/* The owner's API: items, charges, confirmation. Every call needs the signed token. */
import crypto from "node:crypto";
import { json, isAdmin, charges, items, customers, claims, learnItems, learnCustomer, round2, siteUrl, upayCreds, upayCreatePage, icountReady, vatRate, issueInvoice } from "../lib/common.mjs";

const clean = (s, n) => String(s ?? "").trim().slice(0, n);

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!isAdmin(req)) return json({ error: "not signed in" }, 401);
  let b = {};
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const store = charges();

  switch (String(b.action || "")) {
    case "config": {
      const u = upayCreds();
      return json({ ok: true, upay: Boolean(u), upayKey: Boolean(u && u.key), icount: icountReady(), vat: vatRate(), site: siteUrl() });
    }

    case "items": {
      const list = (await items().get("all", { type: "json" })) || [];
      return json({ ok: true, items: list });
    }
    case "customers": {
      const list = (await customers().get("all", { type: "json" })) || [];
      return json({ ok: true, customers: list });
    }
    case "customers-save": {
      const list = (Array.isArray(b.customers) ? b.customers : []).slice(0, 5000).map((c) => ({
        name: clean(c.name, 120), phone: clean(c.phone, 30), email: clean(c.email, 120), uses: Number(c.uses) || 0, last: Number(c.last) || 0,
      })).filter((c) => c.name);
      await customers().setJSON("all", list);
      return json({ ok: true, count: list.length });
    }
    case "items-save": {
      const list = (Array.isArray(b.items) ? b.items : []).slice(0, 5000).map((i) => ({
        name: clean(i.name, 120), sku: clean(i.sku, 40), price: round2(i.price), uses: Number(i.uses) || 0, last: Number(i.last) || 0,
      })).filter((i) => i.name);
      await items().setJSON("all", list);
      return json({ ok: true, count: list.length });
    }

    case "create": {
      const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 40).map((l) => ({
        name: clean(l.name, 120), sku: clean(l.sku, 40), qty: Number(l.qty) || 0, price: round2(l.price),
      })).filter((l) => l.name && l.qty > 0 && l.price >= 0);
      if (!lines.length) return json({ ok: false, reason: "הוסף לפחות שורה אחת עם שם, כמות ומחיר" });
      const total = round2(lines.reduce((a, l) => a + l.price * l.qty, 0));
      if (!(total > 0) || total > 1000000) return json({ ok: false, reason: "הסכום חייב להיות חיובי" });
      const name = clean(b.name, 120), email = clean(b.email, 120), phone = clean(b.phone, 30);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, reason: "כתובת המייל אינה תקינה" });
      const description = clean(b.description, 120) || lines.map((l) => (l.qty !== 1 ? `${l.name} x${l.qty}` : l.name)).join(", ").slice(0, 120);

      /* Remember what was typed, so the next charge is one pick away. */
      try { await learnItems(lines); await learnCustomer({ name, phone, email }); } catch (e) { console.warn("learn failed:", e.message); }

      /* Already paid elsewhere (cash, Bit, a transfer, a card taken some other
         way): no payment link, the charge is recorded as paid and the invoice
         is issued at once. */
      if (b.alreadyPaid) {
        const method = ["cc", "cash", "bank"].includes(b.method) ? b.method : "cc";
        const id = crypto.randomBytes(5).toString("hex");
        await store.setJSON(id, { name, email, phone, lines, total, description, status: "paid", manual: true, method,
          createdAt: Date.now(), paidAt: Date.now() });
        await claims().set(id + ":paid", String(Date.now()), { onlyIfNew: true });
        const out = await issueInvoice(id);
        return json({ ok: true, id, paid: true, invoice: out });
      }

      const u = upayCreds();
      if (!u) return json({ ok: false, reason: "uPay לא מחובר: חסר UPAY_EMAIL ב-Netlify." });
      const site = siteUrl();
      if (!site) return json({ ok: false, reason: "כתובת האתר לא ידועה לשרת." });

      const id = crypto.randomBytes(5).toString("hex");
      const token = crypto.randomBytes(24).toString("hex");
      const back = `${site}/.netlify/functions/ret?c=${id}&k=${token}`;
      let url = "";
      if (u.key) {
        try { url = await upayCreatePage(u, { amount: total, description: `${id} · ${description}`, returnUrl: back, ipnUrl: back + "&ipn=1", phone, email }); }
        catch (e) { console.warn("uPay unreachable:", e.message); }
      }
      if (!url) url = `${site}/.netlify/functions/go?c=${id}&g=${token}`;
      await store.setJSON(id, { name, email, phone, lines, total, description, status: "pending", url, token, verified: Boolean(u.key), createdAt: Date.now() });
      return json({ ok: true, id, url, total, description });
    }

    case "list": {
      const { blobs } = await store.list();
      const all = (await Promise.all(blobs.map(async (x) => ({ id: x.key, ...(await store.get(x.key, { type: "json" })) }))))
        .filter((c) => c && c.createdAt).sort((a, z) => z.createdAt - a.createdAt).slice(0, 60);
      return json({ ok: true, charges: all.map(({ token, ...c }) => c) });   /* the secret token never leaves the server */
    }

    /* Without an API key a payment uPay reported cannot be checked from here,
       so the owner looks in uPay and confirms. */
    case "confirm": {
      const id = clean(b.id, 40);
      const c = id ? await store.get(id, { type: "json" }) : null;
      if (!c) return json({ ok: false, reason: "החיוב לא נמצא" });
      if (c.status !== "paid") {
        if (c.status !== "reported") return json({ ok: false, reason: "uPay עוד לא דיווחה על תשלום בחיוב הזה" });
        await store.setJSON(id, { ...c, status: "paid", paidAt: Date.now(), confirmed: true });
        await claims().set(id + ":paid", String(Date.now()), { onlyIfNew: true });
      }
      return json(await issueInvoice(id));
    }
    case "invoice": return json(await issueInvoice(clean(b.id, 40)));
  }
  return json({ error: "unknown action" }, 400);
};
