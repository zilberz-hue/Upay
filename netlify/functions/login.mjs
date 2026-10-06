import { json, makeToken, loadSettings, hasPassword, checkPassword, createFirstPassword } from "../lib/common.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b = {};
  try { b = await req.json(); } catch {}
  await loadSettings(true);

  /* The page asks first: is there a password yet, or is this the first visit? */
  if (b.action === "status") return json({ ok: true, needsSetup: !hasPassword() });

  await new Promise((r) => setTimeout(r, 400));   /* slows down guessing */

  if (b.action === "setup") {
    const pw = String(b.password || "");
    if (pw.length < 6) return json({ error: "הסיסמה חייבת להיות לפחות 6 תווים" }, 400);
    if (!(await createFirstPassword(pw))) return json({ error: "כבר הוגדרה סיסמה. היכנס עם הסיסמה הקיימת." }, 409);
    return json({ ok: true, token: makeToken() });
  }

  if (!hasPassword()) return json({ error: "עדיין לא הוגדרה סיסמה", needsSetup: true }, 409);
  if (!checkPassword(b.password)) return json({ error: "סיסמה שגויה" }, 401);
  return json({ ok: true, token: makeToken() });
};
