import { json, makeToken, same } from "../lib/common.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!process.env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD לא מוגדר ב-Netlify" }, 503);
  let body = {};
  try { body = await req.json(); } catch {}
  await new Promise((r) => setTimeout(r, 400));   /* slows down guessing */
  if (!same(body.password, process.env.ADMIN_PASSWORD)) return json({ error: "סיסמה שגויה" }, 401);
  return json({ ok: true, token: makeToken() });
};
