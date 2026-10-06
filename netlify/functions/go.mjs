/* On the way to uPay's payment form, for an account connected by email alone:
   the form is filled from the charge (never from the address) and posted at once. */
import { charges, loadSettings, same, siteUrl, upayCreds, upayFormFields, UPAY_FORM } from "../lib/common.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (inner, status = 200) => new Response(
  `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>מעבר לתשלום</title></head><body style="font-family:system-ui,Arial,sans-serif;text-align:center;padding:60px 20px">${inner}</body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export default async (req) => {
  await loadSettings();
  const q = new URL(req.url).searchParams;
  const id = String(q.get("c") || "");
  const c = id ? await charges().get(id, { type: "json" }) : null;
  if (!c || !same(c.token, q.get("g"))) return page("<h2>הקישור לתשלום אינו תקין</h2>", 400);
  if (c.status === "paid" || c.status === "reported") return page("<h2>התשלום הזה כבר התקבל. תודה!</h2>");
  const creds = upayCreds(), site = siteUrl();
  if (!creds || !site) return page("<h2>לא ניתן לעבור לתשלום כרגע</h2><p>נסו שוב בעוד רגע.</p>");
  const back = `${site}/.netlify/functions/ret?c=${id}&k=${c.token}`;
  const fields = upayFormFields(creds, { amount: c.total, description: `${c.description} · ${id}`, returnUrl: back, ipnUrl: back + "&ipn=1", phone: c.phone, email: c.email });
  const inputs = Object.entries(fields).map(([n, v]) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`).join("");
  return page(`<h2>מעבירים אתכם לתשלום מאובטח…</h2><form id="f" action="${UPAY_FORM}" method="post">${inputs}<noscript><button type="submit">להמשך לתשלום</button></noscript></form><script>document.getElementById('f').submit();</script>`);
};
