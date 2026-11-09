// SlotWatch backend (Premium edition)
// - Users sign up for slot alerts on the website OR through the Telegram bot.
// - YOU mark a slot as open (admin panel or Telegram admin commands) and matching
//   users get notified. Premium users are notified instantly; free users after a delay.
// - It never touches VFS and never books anything: users book on the official site.
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

// ---------- config ----------
const ADMIN_USER = env.ADMIN_USER || "samoli";
const ADMIN_PASS = env.ADMIN_PASS || "samoli1122";
const ADMIN_TG = String(env.ADMIN_TELEGRAM_ID || "7813457714").trim();            // your numeric Telegram ID
const FREE_MAX_ALERTS = +env.FREE_MAX_ALERTS || 2;
const PREMIUM_MAX_ALERTS = +env.PREMIUM_MAX_ALERTS || 25;
const FREE_DELAY_SEC = env.FREE_DELAY_SEC !== undefined && env.FREE_DELAY_SEC !== "" ? +env.FREE_DELAY_SEC : 300;
const PREMIUM_INFO = env.PREMIUM_INFO || "Contact the admin to buy Premium.";
const SITE_NAME = env.SITE_NAME || "SlotWatch";
// ---- online payments (UddoktaPay: bKash, Nagad, Rocket, Upay etc. in BDT) ----
const UP_KEY = (env.UDDOKTAPAY_API_KEY || "").trim();
const UP_BASE = (env.UDDOKTAPAY_BASE_URL || "").trim().replace(/\/+$/, "");   // e.g. https://pay.yourdomain.com
const PUBLIC_URL = (env.PUBLIC_URL || "").trim().replace(/\/+$/, "");          // e.g. https://slotwatch.yourdomain.com
const PAY_ON = !!(UP_KEY && UP_BASE && PUBLIC_URL);
const PLANS = (env.PLANS || "30:300,90:800,180:1500").split(",")
  .map((x) => x.trim().split(":").map(Number)).filter(([d, pr]) => d > 0 && pr > 0).map(([days, price]) => ({ days, price }));
if (ADMIN_PASS === "samoli1122") console.warn("WARNING: ADMIN_PASS is still the default. Change it in .env before going live!");

// ---------- proxy setup ----------
// TRUST_PROXY: set when running BEHIND nginx/Caddy/Cloudflare/Render etc. (number of hops, usually 1)
// OUTBOUND_PROXY: optional http(s) proxy for this server's own Telegram + SMTP traffic
const TRUST_PROXY = env.TRUST_PROXY;
const OUTBOUND_PROXY = (env.OUTBOUND_PROXY || "").trim();
let tgDispatcher;
if (OUTBOUND_PROXY) {
  try {
    const u = new URL(OUTBOUND_PROXY);
    if (!/^https?:$/.test(u.protocol)) throw new Error("only http:// or https:// proxies are supported");
    tgDispatcher = new ProxyAgent(OUTBOUND_PROXY);
    console.log(`Outbound proxy enabled for Telegram/SMTP via ${u.protocol}//${u.host}`);
  } catch (e) { console.error("Invalid OUTBOUND_PROXY, ignoring it:", e.message); }
}

// ---------- tiny JSON store ----------
function load() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(DB, "utf8")); } catch (_) {}
  d.alerts ||= []; d.log ||= []; d.premium ||= {}; d.codes ||= {}; d.orders ||= {};
  return d;
}
function save(d) { fs.writeFileSync(DB + ".tmp", JSON.stringify(d, null, 2)); fs.renameSync(DB + ".tmp", DB); }
const norm = (s) => String(s || "").trim().toLowerCase();
const now = () => new Date().toISOString();

// ---------- premium ----------
// db.premium = { "<normalized contact>": "<ISO expiry>" }   (contact = Telegram chat ID or email)
const isPremiumIn = (db, contact) => { const u = db.premium[norm(contact)]; return !!u && new Date(u) > new Date(); };
const isPremium = (contact) => isPremiumIn(load(), contact);
function grantPremium(db, contact, days) {
  const k = norm(contact);
  const base = db.premium[k] && new Date(db.premium[k]) > new Date() ? new Date(db.premium[k]) : new Date();
  base.setDate(base.getDate() + days);
  db.premium[k] = base.toISOString();
  return db.premium[k];
}
const fmtDate = (iso) => new Date(iso).toISOString().slice(0, 10);

// ---------- notifiers ----------
const mailer = env.SMTP_USER
  ? nodemailer.createTransport({
      host: env.SMTP_HOST, port: +env.SMTP_PORT || 587, secure: +env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      ...(tgDispatcher ? { proxy: OUTBOUND_PROXY } : {}),
      connectionTimeout: 15_000,
    })
  : null;

async function sendEmail(to, subject, text) {
  if (!mailer) throw new Error("SMTP not configured");
  await mailer.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject, text });
}

async function tg(method, payload, timeoutMs = 15_000) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram not configured");
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs),
    ...(tgDispatcher ? { dispatcher: tgDispatcher } : {}),
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (!r.ok || !j || !j.ok) throw new Error(`Telegram error ${r.status}${j && j.description ? ": " + j.description : ""}`);
  return j.result;
}
const sendTelegram = (chatId, text) => tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });

async function notify(a, text) {
  if (a.channel === "Email") return sendEmail(a.contact, "A VFS slot may be open", text);
  if (a.channel === "Telegram") return sendTelegram(a.contact, text);
  throw new Error(a.channel + " not supported yet");
}

// ---------- alerts (shared by website + bot) ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHANNELS = ["Email", "Telegram", "WhatsApp"];

function addAlert({ from, to, city, type, ch, ct }) {
  if (![from, to, city, type, ch, ct].every((v) => typeof v === "string" && v.trim() && v.length < 120)) return { error: "Missing or invalid fields" };
  if (!CHANNELS.includes(ch)) return { error: "Bad channel" };
  if (ch === "Email" && !EMAIL_RE.test(ct.trim())) return { error: "Invalid email address" };
  if (ch === "Telegram" && !/^-?\d{5,20}$/.test(ct.trim())) return { error: "Telegram contact must be your numeric chat ID (or use the Telegram bot)" };
  const db = load();
  const dup = db.alerts.find((a) => norm(a.from) === norm(from) && norm(a.to) === norm(to) && norm(a.city) === norm(city) &&
    norm(a.type) === norm(type) && a.channel === ch && norm(a.contact) === norm(ct));
  if (dup) return { alert: dup, duplicate: true };
  const prem = isPremiumIn(db, ct);
  const limit = prem ? PREMIUM_MAX_ALERTS : FREE_MAX_ALERTS;
  const have = db.alerts.filter((a) => norm(a.contact) === norm(ct)).length;
  if (have >= limit) return { error: prem ? `Alert limit reached (${limit}).` : `Free plan allows ${FREE_MAX_ALERTS} alerts. Upgrade to Premium for up to ${PREMIUM_MAX_ALERTS}.` };
  const alert = { id: crypto.randomUUID(), from: from.trim(), to: to.trim(), city: city.trim(), type: type.trim(), channel: ch, contact: ct.trim(), created: now(), notified: null };
  db.alerts.push(alert); save(db);
  return { alert, created: true };
}

// ---------- slot open -> notify ----------
async function deliver(list, text) {
  let sent = 0; const errors = []; const ok = new Set();
  for (const a of list) {
    try { await notify(a, text); ok.add(a.id); sent++; }
    catch (e) { errors.push({ id: a.id, error: e.message }); }
  }
  // reload before saving so signups/deletes made meanwhile are not lost
  const db = load(); const t = now();
  for (const a of db.alerts) if (ok.has(a.id)) a.notified = t;
  save(db);
  return { sent, errors };
}

async function openSlot({ to, city, type, note }) {
  const db = load();
  const hits = db.alerts.filter((a) => norm(a.to) === norm(to) && norm(a.city) === norm(city) && (!type || norm(a.type) === norm(type)));
  const base = `A VFS appointment slot may be available for ${to} (${city}${type ? ", " + type : ""}).${note ? "\n" + note : ""}\n\nSlots go fast. Book yourself on the official site: https://www.vfsglobal.com\n\nSlotWatch is independent and not affiliated with VFS Global.`;
  const prem = hits.filter((a) => isPremiumIn(db, a.contact));
  const free = hits.filter((a) => !isPremiumIn(db, a.contact));
  const r = await deliver(prem, base);
  let scheduled = 0;
  if (free.length) {
    scheduled = free.length;
    const freeText = base + (FREE_DELAY_SEC > 0 ? `\n\n(Free plan: alerts arrive ${Math.round(FREE_DELAY_SEC / 60)} min after Premium. Upgrade for instant alerts.)` : "");
    const run = () => deliver(free, freeText).catch((e) => console.error("free delivery failed:", e.message));
    FREE_DELAY_SEC > 0 ? setTimeout(run, FREE_DELAY_SEC * 1000) : await run();
  }
  const d2 = load();
  d2.log.push({ at: now(), to, city, type: type || null, matched: hits.length, premiumSent: r.sent, freeScheduled: scheduled });
  if (d2.log.length > 1000) d2.log = d2.log.slice(-1000);
  save(d2);
  return { matched: hits.length, sent: r.sent, scheduled, errors: r.errors };
}

// ---------- online payments ----------
async function createPayment(contact, days, name) {
  if (!PAY_ON) throw new Error("Online payment is not set up yet. " + PREMIUM_INFO);
  const plan = PLANS.find((x) => x.days === days);
  if (!plan) throw new Error("Unknown plan");
  const orderId = crypto.randomUUID();
  const r = await fetch(UP_BASE + "/api/checkout-v2", {
    method: "POST",
    headers: { "RT-UDDOKTAPAY-API-KEY": UP_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      full_name: String(name || SITE_NAME + " user").slice(0, 60),
      email: EMAIL_RE.test(contact) ? contact : `${contact}@telegram.user`,
      amount: String(plan.price),
      metadata: { order_id: orderId, contact, days },
      redirect_url: PUBLIC_URL + "/pay/return", return_type: "GET",
      cancel_url: PUBLIC_URL + "/pay/cancel", webhook_url: PUBLIC_URL + "/api/pay/webhook",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.payment_url) throw new Error((j && j.message) || "Payment gateway error");
  const db = load();
  db.orders[orderId] = { id: orderId, contact: String(contact), days, amount: plan.price, status: "pending", created: now() };
  save(db);
  return { url: j.payment_url, plan };
}

// Verifies an invoice SERVER-TO-SERVER with the gateway (never trusts the browser redirect or raw webhook).
async function settleInvoice(invoiceId) {
  if (!PAY_ON || !invoiceId || typeof invoiceId !== "string" || invoiceId.length > 100) return { ok: false, status: "INVALID" };
  const r = await fetch(UP_BASE + "/api/verify-payment", {
    method: "POST",
    headers: { "RT-UDDOKTAPAY-API-KEY": UP_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ invoice_id: invoiceId }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => null);
  if (!j || String(j.status).toUpperCase() !== "COMPLETED") return { ok: false, status: j && j.status };
  const orderId = j.metadata && j.metadata.order_id;
  // ---- everything below is synchronous: no double-activation possible ----
  const db = load(); const o = orderId && db.orders[orderId];
  if (!o) return { ok: false, status: "UNKNOWN_ORDER" };
  if (o.status === "paid") return { ok: true, already: true, order: o };
  if (Object.values(db.orders).some((x) => x.status === "paid" && x.invoice_id === invoiceId)) return { ok: false, status: "REPLAY" };
  if (!(Number(j.amount) >= o.amount)) return { ok: false, status: "AMOUNT_MISMATCH" };
  o.status = "paid"; o.invoice_id = invoiceId; o.paid_at = now(); o.method = j.payment_method || null; o.txid = j.transaction_id || null;
  const until = grantPremium(db, o.contact, o.days);
  save(db);
  const msg = `⭐ Payment received. Premium active until ${fmtDate(until)}. Thank you!`;
  if (/^-?\d{5,20}$/.test(o.contact)) sendTelegram(o.contact, msg).catch(() => {});
  else if (EMAIL_RE.test(o.contact)) sendEmail(o.contact, SITE_NAME + " Premium activated", msg).catch(() => {});
  return { ok: true, order: o, until };
}

const priceList = () => PLANS.map((x) => `• ${x.days} days: ৳${x.price}  →  /buy ${x.days}`).join("\n");

// ---------- Telegram bot (long polling) ----------
const HELP = `${SITE_NAME} - VFS slot alerts

/alert From | To | City | Visa type
  e.g. /alert Bangladesh | Italy | Dhaka | Tourist
/myalerts - list your alerts
/delete N - delete alert number N
/plan - your plan (Free / Premium)
/buy - buy Premium (bKash / Nagad / Rocket)
/redeem CODE - activate Premium with a code
/help - this message

We only alert you. You book yourself on the official VFS site.`;

const ADMIN_HELP = `Admin commands:
/open To | City | Visa type | note   (type & note optional)
/stats
/gencode DAYS [COUNT]
/grant CONTACT DAYS   (chat ID or email)
/revoke CONTACT
/broadcast text`;

const lastCmd = new Map(); // simple per-chat flood control
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  if (!text.startsWith("/") || msg.chat.type !== "private") return;
  const t = Date.now();
  if (t - (lastCmd.get(chatId) || 0) < 700) return;
  lastCmd.set(chatId, t);

  const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return;
  const cmd = m[1].toLowerCase(); const arg = (m[2] || "").trim();
  const isAdmin = ADMIN_TG && chatId === ADMIN_TG;
  const reply = (s) => sendTelegram(chatId, s).catch((e) => console.error("reply failed:", e.message));

  switch (cmd) {
    case "start": case "help":
      return reply(HELP + (isAdmin ? "\n\n" + ADMIN_HELP : ""));

    case "alert": {
      const p = arg.split("|").map((s) => s.trim());
      if (p.length !== 4 || p.some((s) => !s)) return reply("Format: /alert From | To | City | Visa type\nExample: /alert Bangladesh | Italy | Dhaka | Tourist");
      const r = addAlert({ from: p[0], to: p[1], city: p[2], type: p[3], ch: "Telegram", ct: chatId });
      if (r.error) return reply("❌ " + r.error);
      return reply(r.duplicate ? "You already have this alert." : `✅ Alert saved: ${p[0]} → ${p[1]} (${p[2]}, ${p[3]})`);
    }

    case "myalerts": {
      const mine = load().alerts.filter((a) => a.channel === "Telegram" && a.contact === chatId);
      if (!mine.length) return reply("You have no alerts. Add one with /alert");
      return reply(mine.map((a, i) => `${i + 1}. ${a.from} → ${a.to} (${a.city}, ${a.type})`).join("\n") + "\n\nDelete with /delete N");
    }

    case "delete": {
      const n = parseInt(arg, 10);
      const db = load();
      const mine = db.alerts.filter((a) => a.channel === "Telegram" && a.contact === chatId);
      if (!n || n < 1 || n > mine.length) return reply("Usage: /delete N (see /myalerts)");
      db.alerts = db.alerts.filter((a) => a.id !== mine[n - 1].id); save(db);
      return reply("🗑 Deleted.");
    }

    case "plan": case "premium": {
      const db = load();
      const u = db.premium[norm(chatId)];
      const have = db.alerts.filter((a) => norm(a.contact) === norm(chatId)).length;
      if (isPremiumIn(db, chatId)) return reply(`⭐ Premium until ${fmtDate(u)}\nAlerts: ${have}/${PREMIUM_MAX_ALERTS}\nInstant notifications.`);
      return reply(`Free plan\nAlerts: ${have}/${FREE_MAX_ALERTS}\nNotifications arrive ${Math.round(FREE_DELAY_SEC / 60)} min after Premium users.\n\n⭐ Premium: up to ${PREMIUM_MAX_ALERTS} alerts + instant notifications.\n${PREMIUM_INFO}\nBuy now: /buy\nHave a code? /redeem CODE`);
    }

    case "buy": {
      if (!PAY_ON) return reply("Online payment is not available yet.\n" + PREMIUM_INFO);
      const days = parseInt(arg, 10);
      if (!days) return reply("⭐ Premium plans (bKash / Nagad / Rocket):\n" + priceList());
      try {
        const name = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(" ");
        const { url, plan } = await createPayment(chatId, days, name);
        return reply(`Pay ৳${plan.price} for ${plan.days} days Premium:\n${url}\n\nPremium activates automatically after payment.`);
      } catch (e) { return reply("❌ " + e.message); }
    }

    case "redeem": {
      const code = arg.toUpperCase();
      if (!code) return reply("Usage: /redeem CODE");
      const db = load(); const c = db.codes[code];
      if (!c || c.usedBy) return reply("❌ Invalid or already used code.");
      c.usedBy = chatId; c.usedAt = now();
      const until = grantPremium(db, chatId, c.days); save(db);
      return reply(`⭐ Premium activated until ${fmtDate(until)}. Thank you!`);
    }
  }

  // ----- admin-only -----
  if (!isAdmin) return;
  switch (cmd) {
    case "open": {
      const p = arg.split("|").map((s) => s.trim());
      if (p.length < 2 || !p[0] || !p[1]) return reply("Usage: /open To | City | Visa type | note");
      const r = await openSlot({ to: p[0], city: p[1], type: p[2] || "", note: p[3] || "" });
      return reply(`Matched ${r.matched}. Premium sent now: ${r.sent}. Free scheduled: ${r.scheduled}.${r.errors.length ? " Failed: " + r.errors.length : ""}`);
    }
    case "stats": {
      const db = load();
      const act = Object.keys(db.premium).filter((k) => isPremiumIn(db, k)).length;
      const contacts = new Set(db.alerts.map((a) => norm(a.contact))).size;
      const unused = Object.values(db.codes).filter((c) => !c.usedBy).length;
      return reply(`Alerts: ${db.alerts.length}\nUsers: ${contacts}\nActive premium: ${act}\nUnused codes: ${unused}\nSlots opened: ${db.log.length}\nPaid orders: ${Object.values(db.orders).filter((o) => o.status === "paid").length} (৳${Object.values(db.orders).filter((o) => o.status === "paid").reduce((t, o) => t + o.amount, 0)})`);
    }
    case "gencode": {
      const [d, c] = arg.split(/\s+/).map((x) => parseInt(x, 10));
      if (!d || d < 1 || d > 3650) return reply("Usage: /gencode DAYS [COUNT]");
      const db = load(); const out = [];
      for (let i = 0; i < Math.min(c || 1, 20); i++) { const code = "SW-" + crypto.randomBytes(4).toString("hex").toUpperCase(); db.codes[code] = { days: d, created: now(), usedBy: null }; out.push(code); }
      save(db);
      return reply(`Codes (${d} days each):\n` + out.join("\n"));
    }
    case "grant": {
      const [who, d] = arg.split(/\s+/); const days = parseInt(d, 10);
      if (!who || !days) return reply("Usage: /grant CONTACT DAYS");
      const db = load(); const until = grantPremium(db, who, days); save(db);
      sendTelegram(who, `⭐ Premium activated until ${fmtDate(until)}.`).catch(() => {});
      return reply(`Premium for ${who} until ${fmtDate(until)}`);
    }
    case "revoke": {
      if (!arg) return reply("Usage: /revoke CONTACT");
      const db = load(); delete db.premium[norm(arg)]; save(db);
      return reply("Premium removed for " + arg);
    }
    case "broadcast": {
      if (!arg) return reply("Usage: /broadcast text");
      const ids = [...new Set(load().alerts.filter((a) => a.channel === "Telegram").map((a) => a.contact))];
      let ok = 0;
      for (const id of ids) { try { await sendTelegram(id, arg); ok++; } catch (_) {} }
      return reply(`Sent to ${ok}/${ids.length}`);
    }
  }
}

async function startBot() {
  if (!env.TELEGRAM_BOT_TOKEN) return console.log("Telegram bot disabled (no TELEGRAM_BOT_TOKEN).");
  try {
    const me = await tg("getMe");
    console.log(`Telegram bot @${me.username} is running.`);
    await tg("deleteWebhook").catch(() => {});
    await tg("setMyCommands", { commands: [
      { command: "alert", description: "Add a slot alert" }, { command: "myalerts", description: "List my alerts" },
      { command: "delete", description: "Delete an alert" }, { command: "plan", description: "My plan" },
      { command: "redeem", description: "Activate Premium code" }, { command: "help", description: "Help" } ] }).catch(() => {});
  } catch (e) { console.error("Telegram bot could not start:", e.message); }
  let offset = 0, backoff = 1000;
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, 45_000);
      backoff = 1000;
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) handleMessage(u.message).catch((e) => console.error("bot handler error:", e.message));
      }
    } catch (e) {
      console.error("Telegram polling error:", e.message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

// ---------- web app ----------
const app = express();
app.disable("x-powered-by");
if (TRUST_PROXY !== undefined && TRUST_PROXY !== "")
  app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? +TRUST_PROXY : TRUST_PROXY === "true" ? true : TRUST_PROXY);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
const adminLimiter = rateLimit({ windowMs: 15 * 60_000, max: 100, standardHeaders: true, legacyHeaders: false });

function admin(req, res, next) {
  const decoded = Buffer.from((req.headers.authorization || "").split(" ")[1] || "", "base64").toString();
  const i = decoded.indexOf(":");
  const u = i === -1 ? "" : decoded.slice(0, i), p = i === -1 ? "" : decoded.slice(i + 1);
  const userOk = safeEq(u, ADMIN_USER), passOk = safeEq(p, ADMIN_PASS);
  if (userOk && passOk) return next();
  res.set("WWW-Authenticate", 'Basic realm="SlotWatch admin"').status(401).send("Login required");
}

// Public: create an alert
app.post("/api/alerts", rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const r = addAlert(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  res.status(r.created ? 201 : 200).json({ ok: true, id: r.alert.id, duplicate: !!r.duplicate });
});

// Public: plans + start online payment
app.get("/api/plans", (_req, res) => res.json({ enabled: PAY_ON, plans: PLANS, freeMax: FREE_MAX_ALERTS, premiumMax: PREMIUM_MAX_ALERTS, info: PREMIUM_INFO }));
app.post("/api/pay", rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const contact = String((req.body && req.body.contact) || "").trim(); const days = parseInt(req.body && req.body.days, 10);
  if (!(EMAIL_RE.test(contact) || /^-?\d{5,20}$/.test(contact)) || contact.length > 120) return res.status(400).json({ error: "Enter your email or Telegram chat ID" });
  try { const { url } = await createPayment(contact, days); res.json({ url }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Gateway webhook (must be reachable from the internet) - always re-verified with the gateway
app.post("/api/pay/webhook", async (req, res) => {
  if (!PAY_ON || !safeEq(req.headers["rt-uddoktapay-api-key"] || "", UP_KEY)) return res.status(401).json({ error: "unauthorized" });
  try { const r = await settleInvoice(req.body && req.body.invoice_id); res.json({ ok: r.ok }); }
  catch (e) { console.error("webhook error:", e.message); res.status(500).json({ error: "retry" }); }
});
const resultPage = (title, msg) => `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;background:#0f1220;color:#eef0fa;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center"><div><h1>${title}</h1><p>${msg}</p><a style="color:#6c8cff" href="/">Back to ${SITE_NAME}</a></div></body>`;
app.get("/pay/return", async (req, res) => {
  try {
    const r = await settleInvoice(String(req.query.invoice_id || ""));
    if (r.ok) return res.send(resultPage("✅ Payment successful", "Premium is now active. You will get a confirmation message."));
    const pending = /pending/i.test(String(r.status));
    res.status(pending ? 202 : 400).send(resultPage(pending ? "Payment pending" : "Payment not confirmed", pending ? "We are waiting for confirmation. Premium activates automatically once it completes." : "We could not confirm this payment. If money was deducted, contact the admin with your transaction ID."));
  } catch (e) { res.status(500).send(resultPage("Something went wrong", "Please contact the admin with your transaction ID.")); }
});
app.get("/pay/cancel", (_req, res) => res.send(resultPage("Payment cancelled", "No money was taken.")));

// Admin API
app.get("/api/admin/alerts", adminLimiter, admin, (_req, res) => {
  const db = load();
  res.json({ ...db, alerts: db.alerts.map((a) => ({ ...a, premium: isPremiumIn(db, a.contact) })) });
});
app.delete("/api/admin/alerts/:id", adminLimiter, admin, (req, res) => {
  const db = load(); db.alerts = db.alerts.filter((a) => a.id !== req.params.id); save(db); res.json({ ok: true });
});
app.post("/api/admin/slots", adminLimiter, admin, async (req, res) => {
  const { to, city, type, note } = req.body || {};
  if (!to || !city) return res.status(400).json({ error: "to and city required" });
  res.json(await openSlot({ to, city, type, note }));
});
app.post("/api/admin/codes", adminLimiter, admin, (req, res) => {
  const days = parseInt(req.body && req.body.days, 10), count = Math.min(parseInt(req.body && req.body.count, 10) || 1, 50);
  if (!days || days < 1 || days > 3650) return res.status(400).json({ error: "days required (1-3650)" });
  const db = load(); const codes = [];
  for (let i = 0; i < count; i++) { const c = "SW-" + crypto.randomBytes(4).toString("hex").toUpperCase(); db.codes[c] = { days, created: now(), usedBy: null }; codes.push(c); }
  save(db); res.json({ codes });
});
app.post("/api/admin/premium", adminLimiter, admin, (req, res) => {
  const { contact, days } = req.body || {}; const d = parseInt(days, 10);
  if (!contact || !d) return res.status(400).json({ error: "contact and days required" });
  const db = load(); const until = grantPremium(db, String(contact), d); save(db);
  if (/^-?\d{5,20}$/.test(String(contact).trim())) sendTelegram(String(contact).trim(), `⭐ Premium activated until ${fmtDate(until)}.`).catch(() => {});
  res.json({ ok: true, until });
});
app.delete("/api/admin/premium/:contact", adminLimiter, admin, (req, res) => {
  const db = load(); delete db.premium[norm(req.params.contact)]; save(db); res.json({ ok: true });
});

app.get("/admin", adminLimiter, admin, (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));

app.listen(PORT, () => { console.log(`SlotWatch running on http://localhost:${PORT}`); startBot(); });
