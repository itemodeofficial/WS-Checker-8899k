import express from "express";
import cors from "cors";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync } from "fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PYTHON_PORT || "5000", 10);
const AUTH_DIR = join(__dirname, ".wa-auth");
const DB_PATH = join(__dirname, ".wa-data", "checker.db");

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
  stats: db.prepare(`
    SELECT
      COUNT(*)            AS total_checks,
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

// ─── Connection state ─────────────────────────────────────────────────────────

let waClient = null;
let qrCode = null;
let connectionState = "disconnected";
let sseClients = new Set();

// Rapid-cycle detection: track how many times we open→close in under RAPID_MS
const RAPID_MS = 8000;
const MAX_RAPID_CYCLES = 3;
let rapidCycleCount = 0;
let lastOpenTime = 0;
let reconnectTimer = null;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

function setConnectionState(state, qr = null) {
  connectionState = state;
  qrCode = qr;
  broadcast("status", { connection: state, qr });
}

function scheduleReconnect(delay = 2500) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch(console.error);
  }, delay);
}

async function clearAuthAndReconnect() {
  console.log("[WA] Stale session detected — clearing credentials for fresh QR scan");
  const { rmSync } = await import("fs");
  try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  mkdirSync(AUTH_DIR, { recursive: true });
  rapidCycleCount = 0;
  setConnectionState("qr");
  scheduleReconnect(1000);
}

async function startWhatsApp() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
  } = await import("@whiskeysockets/baileys");

  const pino = (await import("pino")).default;
  const logger = pino({ level: "silent" });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });

  waClient = sock;
  setConnectionState("connecting");

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const QRCode = await import("qrcode");
      const qrDataUrl = await QRCode.toDataURL(qr);
      setConnectionState("qr", qrDataUrl);
      console.log("[WA] QR code ready — scan with your phone to link the account");
    }

    if (connection === "open") {
      lastOpenTime = Date.now();
      console.log("[WA] Connected successfully");
      setConnectionState("connected");
      // Reset cycle counter only after staying connected for 30s
      setTimeout(() => {
        if (connectionState === "connected") rapidCycleCount = 0;
      }, 30000);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      waClient = null;
      console.log(`[WA] Connection closed — status: ${statusCode ?? "unknown"}, loggedOut: ${loggedOut}`);

      if (loggedOut) {
        // Explicitly revoked from phone: clear creds and show fresh QR
        await clearAuthAndReconnect();
        return;
      }

      // Detect rapid open→close cycle (stale/invalid session)
      const timeSinceOpen = Date.now() - lastOpenTime;
      if (lastOpenTime > 0 && timeSinceOpen < RAPID_MS) {
        rapidCycleCount++;
        console.log(`[WA] Rapid cycle #${rapidCycleCount} (closed ${timeSinceOpen}ms after open)`);
        if (rapidCycleCount >= MAX_RAPID_CYCLES) {
          await clearAuthAndReconnect();
          return;
        }
      }

      // Normal closure — reconnect with back-off
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

// ─── SSE ──────────────────────────────────────────────────────────────────────

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`event: status\ndata: ${JSON.stringify({ connection: connectionState, qr: qrCode })}\n\n`);

  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); }
  }, 20000);

  sseClients.add(res);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ─── Status & Health ──────────────────────────────────────────────────────────

app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok", connection: connectionState });
});

app.get("/api/status", (req, res) => {
  res.json({
    connection: connectionState,
    qr: connectionState === "qr" ? qrCode : null,
  });
});

// ─── Connect (manual trigger) ─────────────────────────────────────────────────

app.post("/api/connect", async (req, res) => {
  if (connectionState === "connected") {
    return res.json({ message: "Already connected", connection: connectionState });
  }
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

// ─── Check ────────────────────────────────────────────────────────────────────

app.post("/api/check", async (req, res) => {
  if (connectionState !== "connected" || !waClient) {
    return res.status(503).json({
      error: "WhatsApp not connected. Please scan the QR code first.",
      connection: connectionState,
      qr: connectionState === "qr" ? qrCode : null,
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

  for (const raw of numbers) {
    const number = String(raw).trim().replace(/[\s\-\(\)]/g, "");
    const digits = number.replace(/^\+/, "");

    if (!digits || digits.length < 7) {
      results.push({ number: String(raw), formattedNumber: String(raw), hasWhatsapp: false, error: "Invalid number format" });
      withoutWA++;
      continue;
    }

    try {
      const [result] = await waClient.onWhatsApp(digits);
      if (result?.exists) {
        results.push({ number: String(raw), formattedNumber: `+${digits}`, hasWhatsapp: true, error: null });
        withWA++;
      } else {
        results.push({ number: String(raw), formattedNumber: `+${digits}`, hasWhatsapp: false, error: null });
        withoutWA++;
      }
    } catch (err) {
      results.push({ number: String(raw), formattedNumber: `+${digits}`, hasWhatsapp: false, error: "Could not determine (network issue)" });
      withoutWA++;
    }

    await new Promise((r) => setTimeout(r, 300));
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
  });
});

// ─── API Docs (JSON) ──────────────────────────────────────────────────────────

app.get("/api/docs", (req, res) => {
  res.json({ title: "WhatsApp Number Checker API", version: "1.0.0", baseUrl: "/api" });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[API] WhatsApp checker server running on port ${PORT}`);
});
