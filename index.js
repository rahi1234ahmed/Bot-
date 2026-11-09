// SlotWatch backend: stores alert signups and notifies users when YOU
// mark a slot as open from the admin panel. It never touches VFS and
// never books anything: users book themselves on the official site.
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const { ProxyAgent } = require("undici");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

try { process.loadEnvFile && process.loadEnvFile(); } catch (_) {}
const env = process.env;
const PORT = env.PORT || 3000;
const DB = path.join(__dirname, "data.json");

// ---------- config warnings ----------
const ADMIN_USER = env.ADMIN_USER || "admin";
const ADMIN_PASS = env.ADMIN_PASS || "change-me-now";
if (ADMIN_PASS === "change-me-now") {
  console.warn("WARNING: ADMIN_PASS is still the default. Change it in .env before going live!");
}

// ---------- proxy setup ----------
// 1) TRUST_PROXY: set when this app runs BEHIND a reverse proxy (nginx, Caddy,
//    Cloudflare, Render, Railway...). Needed so rate limiting sees the real
//    visitor IP instead of the proxy's IP. Use a number of hops (usually 1).
// 2) OUTBOUND_PROXY: optional proxy for the server's OWN outgoing traffic
//    (Telegram API + SMTP), e.g. http://user:pass@host:8080
const TRUST_PROXY = env.TRUST_PROXY;
const OUTBOUND_PROXY = (env.OUTBOUND_PROXY || "").trim();

let tgDispatcher;
if (OUTBOUND_PROXY) {
  try {
    const u = new URL(OUTBOUND_PROXY);
    if (!/^https?:$/.test(u.protocol)) throw new Error("only http:// or https:// proxies are supported");
    tgDispatcher = new ProxyAgent(OUTBOUND_PROXY);
    console.log(`Outbound proxy enabled for Telegram/SMTP via ${u.protocol}//${u.host}`);
  } catch (e) {
    console.error("Invalid OUTBOUND_PROXY, ignoring it:", e.message);
  }
}

// ---------- tiny JSON store ----------
function load() { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return { alerts: [], log: [] }; } }
function save(d) { fs.writeFileSync(DB + ".tmp", JSON.stringify(d, null, 2)); fs.renameSync(DB + ".tmp", DB); }
const norm = (s) => String(s || "").trim().toLowerCase();

// ---------- notifiers ----------
const mailer = env.SMTP_USER
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: +env.SMTP_PORT || 587,
      secure: +env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      ...(tgDispatcher ? { proxy: OUTBOUND_PROXY } : {}),
      connectionTimeout: 15_000,
    })
  : null;

async function sendEmail(to, subject, text) {
  if (!mailer) throw new Error("SMTP not configured");
  await mailer.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject, text });
}

async function sendTelegram(chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram not configured");
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
    ...(tgDispatcher ? { dispatcher: tgDispatcher } : {}),
  });
  if (!r.ok) {
    let why = "";
    try { why = (await r.json()).description || ""; } catch (_) {}
    throw new Error(`Telegram error ${r.status}${why ? ": " + why : ""}`);
  }
}

async function notify(a, text) {
  if (a.channel === "Email") return sendEmail(a.contact, "A VFS slot may be open", text);
  if (a.channel === "Telegram") return sendTelegram(a.contact, text);
  throw new Error(a.channel + " not supported yet");
}

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
if (TRUST_PROXY !== undefined && TRUST_PROXY !== "") {
  // "1" -> 1 hop, "true" -> true, otherwise pass through (e.g. "loopback")
  app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? +TRUST_PROXY : TRUST_PROXY === "true" ? true : TRUST_PROXY);
}
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Constant-time compare that does not break on different lengths
const safeEq = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Slow down password guessing on admin routes
const adminLimiter = rateLimit({ windowMs: 15 * 60_000, max: 100, standardHeaders: true, legacyHeaders: false });

function admin(req, res, next) {
  const h = req.headers.authorization || "";
  const decoded = Buffer.from(h.split(" ")[1] || "", "base64").toString();
  const i = decoded.indexOf(":"); // password may contain ":"
  const u = i === -1 ? "" : decoded.slice(0, i);
  const p = i === -1 ? "" : decoded.slice(i + 1);
  const userOk = safeEq(u, ADMIN_USER);
  const passOk = safeEq(p, ADMIN_PASS);
  if (userOk && passOk) return next();
  res.set("WWW-Authenticate", 'Basic realm="SlotWatch admin"').status(401).send("Login required");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public: create an alert
app.post("/api/alerts", rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const { from, to, city, type, ch, ct } = req.body || {};
  if (![from, to, city, type, ch, ct].every((v) => typeof v === "string" && v.trim() && v.length < 120))
    return res.status(400).json({ error: "Missing or invalid fields" });
  if (!["Email", "Telegram", "WhatsApp"].includes(ch)) return res.status(400).json({ error: "Bad channel" });
  if (ch === "Email" && !EMAIL_RE.test(ct.trim())) return res.status(400).json({ error: "Invalid email address" });
  if (ch === "Telegram" && !/^-?\d{5,20}$/.test(ct.trim())) return res.status(400).json({ error: "Telegram contact must be your numeric chat ID" });

  const db = load();
  // avoid duplicate alerts for the same person + route
  const dup = db.alerts.find((a) =>
    norm(a.from) === norm(from) && norm(a.to) === norm(to) && norm(a.city) === norm(city) &&
    norm(a.type) === norm(type) && a.channel === ch && norm(a.contact) === norm(ct));
  if (dup) return res.status(200).json({ ok: true, id: dup.id, duplicate: true });

  const alert = { id: crypto.randomUUID(), from: from.trim(), to: to.trim(), city: city.trim(), type: type.trim(), channel: ch, contact: ct.trim(), created: new Date().toISOString(), notified: null };
  db.alerts.push(alert);
  save(db);
  res.status(201).json({ ok: true, id: alert.id });
});

// Admin: list / delete alerts
app.get("/api/admin/alerts", adminLimiter, admin, (_req, res) => res.json(load()));
app.delete("/api/admin/alerts/:id", adminLimiter, admin, (req, res) => {
  const db = load(); db.alerts = db.alerts.filter((a) => a.id !== req.params.id); save(db); res.json({ ok: true });
});

// Admin: mark slot open for a route -> notify matching alerts
app.post("/api/admin/slots", adminLimiter, admin, async (req, res) => {
  const { to, city, type, note } = req.body || {};
  if (!to || !city) return res.status(400).json({ error: "to and city required" });
  const hits = load().alerts.filter((a) => norm(a.to) === norm(to) && norm(a.city) === norm(city) && (!type || norm(a.type) === norm(type)));
  const text = `A VFS appointment slot may be available for ${to} (${city}${type ? ", " + type : ""}).${note ? "\n" + note : ""}\n\nSlots go fast. Book yourself on the official site: https://www.vfsglobal.com\n\nSlotWatch is independent and not affiliated with VFS Global.`;

  let sent = 0; const errors = []; const notifiedIds = new Set();
  for (const a of hits) {
    try { await notify(a, text); notifiedIds.add(a.id); sent++; }
    catch (e) { errors.push({ id: a.id, error: e.message }); }
  }

  // Reload before saving so signups/deletes made while we were sending are not lost
  const db = load();
  const now = new Date().toISOString();
  for (const a of db.alerts) if (notifiedIds.has(a.id)) a.notified = now;
  db.log.push({ at: now, to, city, type: type || null, matched: hits.length, sent });
  save(db);
  res.json({ matched: hits.length, sent, errors });
});

// Admin panel
app.get("/admin", adminLimiter, admin, (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));

app.listen(PORT, () => console.log(`SlotWatch running on http://localhost:${PORT}`));
