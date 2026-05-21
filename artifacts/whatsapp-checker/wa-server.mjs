import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync } from "fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// ─── Security & Performance ───────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: false, // disabled so React app loads fine
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Rate limiting — prevents abuse on the check endpoints
const checkLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // max 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a moment before trying again." },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/check", checkLimiter);
app.use("/api", generalLimiter);

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || process.env.PYTHON_PORT || "5000", 10);
const IS_PROD = process.env.NODE_ENV === "production";
const AUTH_DIR = join(__dirname, IS_PROD ? ".wa-auth" : ".wa-auth-dev");
const DB_PATH = join(__dirname, ".wa-data", IS_PROD ? "checker.db" : "checker-dev.db");

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
mkdirSync(join(__dirname, ".wa-data"), { recursive: true });

// ─── SQLite Database ──────────────────────────────────────────────────────────

const Database = require("better-sqlite3");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    total      INTEGER NOT NULL DEFAULT 0,
    with_wa    INTEGER NOT NULL DEFAULT 0,
    without_wa INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS results (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    number           TEXT NOT NULL,
    formatted_number TEXT NOT NULL,
    has_whatsapp     INTEGER NOT NULL DEFAULT 0,
    error            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_results_session ON results(session_id);
`);

const stmts = {
  insertSession: db.prepare(
    "INSERT INTO sessions (total, with_wa, without_wa, checked_at) VALUES (?, ?, ?, ?)"
  ),
  insertResult: db.prepare(
    "INSERT INTO results (session_id, number, formatted_number, has_whatsapp, error) VALUES (?, ?, ?, ?, ?)"
  ),
  listSessions: db.prepare(
    "SELECT id, total, with_wa, without_wa, checked_at FROM sessions ORDER BY id DESC"
  ),
  getSession: db.prepare(
    "SELECT id, total, with_wa, without_wa, checked_at FROM sessions WHERE id = ?"
  ),
  getResults: db.prepare(
    "SELECT number, formatted_number, has_whatsapp, error FROM results WHERE session_id = ? ORDER BY id"
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  clearAllSessions: db.prepare("DELETE FROM sessions"),
  stats: db.prepare(`
    SELECT
      COUNT(*)                     AS total_checks,
      COALESCE(SUM(total), 0)      AS total_numbers,
      COALESCE(SUM(with_wa), 0)    AS total_with,
      COALESCE(SUM(without_wa), 0) AS total_without
    FROM sessions
  `),
};

function saveSession(results, withWA, withoutWA) {
  const checkedAt = new Date().toISOString();
  const info = stmts.insertSession.run(results.length, withWA, withoutWA, checkedAt);
  const sessionId = info.lastInsertRowid;

  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      stmts.insertResult.run(
        sessionId,
        r.number,
        r.formattedNumber,
        r.hasWhatsapp ? 1 : 0,
        r.error ?? null
      );
    }
  });
  insertMany(results);

  return {
    id: Number(sessionId),
    total: results.length,
    withWhatsapp: withWA,
    withoutWhatsapp: withoutWA,
    checkedAt,
    results,
  };
}

function rowToSession(row) {
  return {
    id: row.id,
    total: row.total,
    withWhatsapp: row.with_wa,
    withoutWhatsapp: row.without_wa,
    checkedAt: row.checked_at,
  };
}

function rowToResult(row) {
  return {
    number: row.number,
    formattedNumber: row.formatted_number,
    hasWhatsapp: row.has_whatsapp === 1,
    error: row.error ?? null,
  };
}

// ─── Telegram Notifications ───────────────────────────────────────────────────

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "6728122351";
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const tgLastSent = new Map();

async function tgSend(message, key = null) {
  if (!TG_TOKEN) return;
  if (key) {
    const last = tgLastSent.get(key) || 0;
    if (Date.now() - last < 60_000) return;
    tgLastSent.set(key, Date.now());
  }
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error(`[TG] Error: ${e.message}`);
  }
}

// ─── Connection State ─────────────────────────────────────────────────────────

let waClient = null;
let qrCode = null;
let qrVersion = 0;
let connectionState = "disconnected";
let sseClients = new Set();

const RAPID_MS = 8000;
const MAX_RAPID_CYCLES = 3;
let rapidCycleCount = 0;
let lastOpenTime = 0;
let reconnectTimer = null;

// Track whether we want to stay disconnected (manual disconnect)
let manualDisconnect = false;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

function setConnectionState(state, qr = null) {
  connectionState = state;
  if (qr !== null) {
    qrCode = qr;
    qrVersion++;
  } else if (state !== "qr") {
    qrCode = null;
  }
  broadcast("status", { connection: state, qrVersion: state === "qr" ? qrVersion : 0 });
}

function scheduleReconnect(delay = 2500) {
  if (manualDisconnect) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch(console.error);
  }, delay);
}

async function clearAuthAndReconnect() {
  console.log("[WA] Stale session — clearing credentials for fresh QR scan");
  const { rmSync } = await import("fs");
  try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  mkdirSync(AUTH_DIR, { recursive: true });
  rapidCycleCount = 0;
  setConnectionState("qr");
  scheduleReconnect(1000);
}

async function startWhatsApp() {
  if (manualDisconnect) return;

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    Browsers,
  } = await import("@whiskeysockets/baileys");

  const pino = (await import("pino")).default;
  const logger = pino({ level: "silent" });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (_) {
    version = [2, 3000, 1023156030];
  }

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 500,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });

  waClient = sock;
  setConnectionState("connecting");

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const QRCode = await import("qrcode");
      const qrDataUrl = await QRCode.toDataURL(qr, { scale: 12, margin: 2 });
      setConnectionState("qr", qrDataUrl);
      console.log("[WA] QR code ready — scan with your phone");
      tgSend(
        "⚠️ <b>WhatsApp Checker — QR Code প্রয়োজন</b>\n\n" +
        "WhatsApp একাউন্ট লিঙ্ক করতে QR code স্ক্যান করুন।\n\n" +
        "🕐 সময়: " + new Date().toLocaleString("bn-BD", { timeZone: "Asia/Dhaka" }),
        "qr"
      );
    }

    if (connection === "open") {
      lastOpenTime = Date.now();
      manualDisconnect = false;
      console.log("[WA] Connected successfully");
      setConnectionState("connected");
      tgSend(
        "✅ <b>WhatsApp Checker — সংযুক্ত হয়েছে</b>\n\n" +
        "WhatsApp সফলভাবে কানেক্ট হয়েছে।\n\n" +
        "🕐 সময়: " + new Date().toLocaleString("bn-BD", { timeZone: "Asia/Dhaka" }),
        "connected"
      );
      setTimeout(() => {
        if (connectionState === "connected") rapidCycleCount = 0;
      }, 30000);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const connectionReplaced = statusCode === DisconnectReason.connectionReplaced;

      waClient = null;
      console.log(`[WA] Closed — code: ${statusCode ?? "?"}, loggedOut: ${loggedOut}, replaced: ${connectionReplaced}`);

      const reason = loggedOut
        ? "অ্যাকাউন্ট লগআউট"
        : connectionReplaced
        ? "অন্য ডিভাইস থেকে লগইন (কোড 440)"
        : `কোড: ${statusCode ?? "N/A"}`;

      tgSend(
        "🔴 <b>WhatsApp Checker — সংযোগ বিচ্ছিন্ন</b>\n\n" +
        `❌ কারণ: ${reason}\n` +
        (!manualDisconnect ? "🔄 পুনরায় সংযোগের চেষ্টা হচ্ছে…\n\n" : "") +
        "🕐 সময়: " + new Date().toLocaleString("bn-BD", { timeZone: "Asia/Dhaka" }),
        "disconnected"
      );

      if (manualDisconnect) {
        setConnectionState("disconnected");
        return;
      }

      if (loggedOut || connectionReplaced) {
        await clearAuthAndReconnect();
        return;
      }

      const timeSinceOpen = Date.now() - lastOpenTime;
      if (lastOpenTime > 0 && timeSinceOpen < RAPID_MS) {
        rapidCycleCount++;
        if (rapidCycleCount >= MAX_RAPID_CYCLES) {
          await clearAuthAndReconnect();
          return;
        }
      }

      const delay = rapidCycleCount > 0 ? 5000 + rapidCycleCount * 2000 : 2500;
      setConnectionState("connecting");
      console.log(`[WA] Reconnecting in ${delay}ms…`);
      scheduleReconnect(delay);
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
}

startWhatsApp().catch(console.error);

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  console.log(`[Server] ${signal} received — shutting down gracefully`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (waClient) {
    try { await waClient.end(); } catch (_) {}
  }
  db.close();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ─── SSE ──────────────────────────────────────────────────────────────────────

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disables Nginx buffering for SSE
  res.flushHeaders();

  res.write(`event: status\ndata: ${JSON.stringify({ connection: connectionState, qrVersion: connectionState === "qr" ? qrVersion : 0 })}\n\n`);

  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); }
  }, 20000);

  sseClients.add(res);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ─── Health & Status ──────────────────────────────────────────────────────────

app.get("/api/healthz", (req, res) => {
  res.json({
    status: "ok",
    connection: connectionState,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
    clients: sseClients.size,
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    connection: connectionState,
    qrVersion: connectionState === "qr" ? qrVersion : 0,
  });
});

app.get("/api/qr", (req, res) => {
  if (!qrCode || connectionState !== "qr") {
    return res.status(404).json({ error: "No QR available right now" });
  }
  const base64 = qrCode.replace(/^data:image\/png;base64,/, "");
  const buf = Buffer.from(base64, "base64");
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "no-store");
  res.send(buf);
});

// ─── Force fresh QR ───────────────────────────────────────────────────────────

app.post("/api/force-qr", async (req, res) => {
  console.log("[WA] Force-QR requested — wiping auth");
  manualDisconnect = false;
  if (waClient) {
    try { await waClient.end(); } catch (_) {}
    waClient = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  await clearAuthAndReconnect();
  res.json({ message: "Fresh QR incoming…", connection: "connecting" });
});

// ─── Connect (manual) ────────────────────────────────────────────────────────

app.post("/api/connect", async (req, res) => {
  if (connectionState === "connected") {
    return res.json({ message: "Already connected", connection: connectionState });
  }
  manualDisconnect = false;
  if (waClient) {
    try { await waClient.end(); } catch (_) {}
    waClient = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  rapidCycleCount = 0;
  setConnectionState("connecting");
  startWhatsApp().catch(console.error);
  res.json({ message: "Connecting…", connection: "connecting" });
});

// ─── Disconnect (manual) ─────────────────────────────────────────────────────

app.post("/api/disconnect", async (req, res) => {
  console.log("[WA] Manual disconnect requested");
  manualDisconnect = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (waClient) {
    try { await waClient.end(); } catch (_) {}
    waClient = null;
  }
  setConnectionState("disconnected");
  res.json({ message: "Disconnected", connection: "disconnected" });
});

// ─── Check single number ─────────────────────────────────────────────────────

app.get("/api/check/:number", async (req, res) => {
  if (connectionState !== "connected" || !waClient) {
    return res.status(503).json({
      error: "WhatsApp not connected. Please scan the QR code first.",
      connection: connectionState,
      qrVersion: connectionState === "qr" ? qrVersion : 0,
    });
  }

  const raw = decodeURIComponent(req.params.number);
  const number = raw.trim().replace(/[\s\-\(\)]/g, "");
  const digits = number.replace(/^\+/, "");

  if (!digits || digits.length < 7) {
    return res.status(400).json({
      number: raw, formattedNumber: raw, hasWhatsapp: false, error: "Invalid number format",
    });
  }

  try {
    const [result] = await waClient.onWhatsApp(digits);
    return res.json({
      number: raw, formattedNumber: `+${digits}`, hasWhatsapp: result?.exists === true, error: null,
    });
  } catch (err) {
    return res.status(500).json({
      number: raw, formattedNumber: `+${digits}`, hasWhatsapp: false, error: "Could not determine (network issue)",
    });
  }
});

// ─── Batch check ─────────────────────────────────────────────────────────────

app.post("/api/check", async (req, res) => {
  if (connectionState !== "connected" || !waClient) {
    return res.status(503).json({
      error: "WhatsApp not connected. Please scan the QR code first.",
      connection: connectionState,
      qrVersion: connectionState === "qr" ? qrVersion : 0,
    });
  }

  const { numbers } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "numbers must be a non-empty array" });
  }
  if (numbers.length > 100) {
    return res.status(400).json({ error: "Maximum 100 numbers per request" });
  }

  const results = [];
  let withWA = 0;
  let withoutWA = 0;

  // Broadcast progress start
  broadcast("progress", { checked: 0, total: numbers.length, current: null });

  for (let i = 0; i < numbers.length; i++) {
    const raw = String(numbers[i]);
    const number = raw.trim().replace(/[\s\-\(\)]/g, "");
    const digits = number.replace(/^\+/, "");

    if (!digits || digits.length < 7) {
      results.push({ number: raw, formattedNumber: raw, hasWhatsapp: false, error: "Invalid number format" });
      withoutWA++;
    } else {
      try {
        const [result] = await waClient.onWhatsApp(digits);
        if (result?.exists) {
          results.push({ number: raw, formattedNumber: `+${digits}`, hasWhatsapp: true, error: null });
          withWA++;
        } else {
          results.push({ number: raw, formattedNumber: `+${digits}`, hasWhatsapp: false, error: null });
          withoutWA++;
        }
      } catch (err) {
        results.push({ number: raw, formattedNumber: `+${digits}`, hasWhatsapp: false, error: "Network issue" });
        withoutWA++;
        console.error(`[CHECK] Error +${digits}:`, err.message);
      }
    }

    // Broadcast live progress after each number
    broadcast("progress", {
      checked: i + 1,
      total: numbers.length,
      current: `+${digits}`,
      withWA,
      withoutWA,
    });

    if (i < numbers.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  // Progress done
  broadcast("progress", { checked: numbers.length, total: numbers.length, done: true });

  const errorCount = results.filter((r) => r.error && r.error !== "Invalid number format").length;
  if (errorCount > 0) {
    tgSend(
      "⚠️ <b>WhatsApp Checker — চেকিং সমস্যা</b>\n\n" +
      `📋 মোট: ${numbers.length} | ✅ আছে: ${withWA} | ❌ নেই: ${withoutWA - errorCount} | ⚠️ সমস্যা: ${errorCount}\n\n` +
      "🕐 সময়: " + new Date().toLocaleString("bn-BD", { timeZone: "Asia/Dhaka" }),
      "check_error"
    );
  }

  const session = saveSession(results, withWA, withoutWA);
  res.json(session);
});

// ─── History ──────────────────────────────────────────────────────────────────

app.get("/api/history", (req, res) => {
  const rows = stmts.listSessions.all();
  res.json(rows.map(rowToSession));
});

app.get("/api/history/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = stmts.getSession.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const results = stmts.getResults.all(id).map(rowToResult);
  res.json({ ...rowToSession(session), results });
});

app.delete("/api/history/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = stmts.getSession.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  stmts.deleteSession.run(id);
  res.json({ message: "Session deleted" });
});

app.delete("/api/history", (req, res) => {
  stmts.clearAllSessions.run();
  res.json({ message: "All history cleared" });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get("/api/stats", (req, res) => {
  const row = stmts.stats.get();
  const total = Number(row.total_numbers);
  const withWA = Number(row.total_with);
  res.json({
    totalChecks: Number(row.total_checks),
    totalNumbersChecked: total,
    totalWithWhatsapp: withWA,
    totalWithoutWhatsapp: Number(row.total_without),
    successRate: total > 0 ? Math.round((withWA / total) * 1000) / 10 : 0,
    uptime: Math.floor(process.uptime()),
  });
});

// ─── API Docs ─────────────────────────────────────────────────────────────────

app.get("/api/docs", (req, res) => {
  res.json({ title: "WhatsApp Number Checker API", version: "2.0.0", baseUrl: "/api" });
});

// ─── Static Frontend (production) ────────────────────────────────────────────

const distDir = join(__dirname, "dist", "public");
if (existsSync(distDir)) {
  app.use(express.static(distDir, {
    maxAge: "1d",
    etag: true,
  }));
  app.get("/{*path}", (_req, res) => {
    res.sendFile(join(distDir, "index.html"));
  });
  console.log(`[API] Serving static frontend from ${distDir}`);
}

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[API] WhatsApp Checker v2.0 running on port ${PORT} (${IS_PROD ? "production" : "development"})`);
  tgSend(
    "🚀 <b>WhatsApp Checker — সার্ভার চালু হয়েছে</b>\n\n" +
    `পোর্ট: ${PORT} | মোড: ${IS_PROD ? "Production" : "Dev"}\n\n` +
    "🕐 সময়: " + new Date().toLocaleString("bn-BD", { timeZone: "Asia/Dhaka" })
  );
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
