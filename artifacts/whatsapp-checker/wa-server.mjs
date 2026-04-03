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

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

let waClient = null;
let qrCode = null;
let connectionState = "disconnected";
let checkHistory = [];
let sessionCounter = 0;
let sseClients = new Set();

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
      console.log("[WA] QR code ready — scan to authenticate");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log("[WA] Connection closed. LoggedOut:", loggedOut, "— reconnecting…");
      waClient = null;
      if (loggedOut) {
        // Session was revoked from the phone — clear stale creds then reconnect for a fresh QR
        const { rmSync } = await import("fs");
        try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        mkdirSync(AUTH_DIR, { recursive: true });
      }
      // Always reconnect — never stay permanently disconnected
      setConnectionState("connecting");
      setTimeout(startWhatsApp, 2500);
    }

    if (connection === "open") {
      console.log("[WA] Connected successfully");
      setConnectionState("connected");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

startWhatsApp().catch(console.error);

// ─── SSE ────────────────────────────────────────────────────────────────────

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately on connect
  res.write(`event: status\ndata: ${JSON.stringify({ connection: connectionState, qr: qrCode })}\n\n`);

  // Keep-alive ping every 20s
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); }
  }, 20000);

  sseClients.add(res);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ─── Status ─────────────────────────────────────────────────────────────────

app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok", connection: connectionState });
});

app.get("/api/status", (req, res) => {
  res.json({
    connection: connectionState,
    qr: connectionState === "qr" ? qrCode : null,
  });
});

// ─── Connect (manual trigger) ────────────────────────────────────────────────

app.post("/api/connect", async (req, res) => {
  if (connectionState === "connected") {
    return res.json({ message: "Already connected", connection: connectionState });
  }
  if (waClient) {
    try { await waClient.end(); } catch (_) {}
    waClient = null;
  }
  setConnectionState("connecting");
  startWhatsApp().catch(console.error);
  res.json({ message: "Connecting…", connection: "connecting" });
});

// ─── Check ───────────────────────────────────────────────────────────────────

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
  let withWhatsapp = 0;
  let withoutWhatsapp = 0;

  for (const raw of numbers) {
    const number = String(raw).trim().replace(/[\s\-\(\)]/g, "");
    const digits = number.replace(/^\+/, "");

    if (!digits || digits.length < 7) {
      results.push({
        number: String(raw),
        formattedNumber: String(raw),
        hasWhatsapp: false,
        error: "Invalid number format",
      });
      withoutWhatsapp++;
      continue;
    }

    try {
      const [result] = await waClient.onWhatsApp(digits);
      if (result?.exists) {
        results.push({ number: String(raw), formattedNumber: `+${digits}`, hasWhatsapp: true, error: null });
        withWhatsapp++;
      } else {
        results.push({ number: String(raw), formattedNumber: `+${digits}`, hasWhatsapp: false, error: null });
        withoutWhatsapp++;
      }
    } catch (err) {
      results.push({ number: String(raw), formattedNumber: `+${digits}`, hasWhatsapp: false, error: "Could not determine (network issue)" });
      withoutWhatsapp++;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  sessionCounter++;
  const session = {
    id: sessionCounter,
    total: results.length,
    withWhatsapp,
    withoutWhatsapp,
    checkedAt: new Date().toISOString(),
    results,
  };
  checkHistory.push(session);
  res.json(session);
});

// ─── History ─────────────────────────────────────────────────────────────────

app.get("/api/history", (req, res) => {
  const summary = [...checkHistory].reverse().map((s) => ({
    id: s.id,
    total: s.total,
    withWhatsapp: s.withWhatsapp,
    withoutWhatsapp: s.withoutWhatsapp,
    checkedAt: s.checkedAt,
  }));
  res.json(summary);
});

app.get("/api/history/:id", (req, res) => {
  const session = checkHistory.find((s) => s.id === parseInt(req.params.id));
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get("/api/stats", (req, res) => {
  const totalChecks = checkHistory.length;
  const totalNumbers = checkHistory.reduce((a, s) => a + s.total, 0);
  const totalWith = checkHistory.reduce((a, s) => a + s.withWhatsapp, 0);
  const totalWithout = checkHistory.reduce((a, s) => a + s.withoutWhatsapp, 0);
  res.json({
    totalChecks,
    totalNumbersChecked: totalNumbers,
    totalWithWhatsapp: totalWith,
    totalWithoutWhatsapp: totalWithout,
    successRate: totalNumbers > 0 ? Math.round((totalWith / totalNumbers) * 1000) / 10 : 0,
  });
});

// ─── API Docs (JSON) ──────────────────────────────────────────────────────────

app.get("/api/docs", (req, res) => {
  res.json({
    title: "WhatsApp Number Checker API",
    version: "1.0.0",
    baseUrl: "/api",
    description: "Check whether phone numbers are registered on WhatsApp. Requires a one-time QR scan to link your WhatsApp account. The session persists automatically — no repeated logins needed.",
    note: "All requests and responses use JSON. No API key or authentication header required.",
    connectionLifecycle: {
      description: "Scan the QR code once. The session is saved and reconnects automatically on server restart or network drop. You only need to re-scan if you remove the linked device from your WhatsApp app.",
      states: {
        connecting: "Server is trying to establish a connection using saved credentials.",
        qr: "No saved session — scan the QR code from GET /api/status to link your account.",
        connected: "Ready. You can call POST /api/check.",
        logged_out: "Session was revoked from the phone. A new QR will be generated automatically.",
      },
    },
    endpoints: {
      "GET /api/status": {
        description: "Return current connection state and QR code image when needed.",
        response: {
          connection: "connecting | qr | connected | logged_out",
          qr: "base64 PNG data URL, present only when connection === 'qr', otherwise null",
        },
        examples: {
          connected: { connection: "connected", qr: null },
          needsQR: { connection: "qr", qr: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..." },
        },
      },
      "GET /api/events": {
        description: "Server-Sent Events stream. Pushes status updates in real time without polling.",
        usage: "Connect with EventSource. Receives the current state immediately, then on every change.",
        eventName: "status",
        payload: { connection: "string", qr: "string | null" },
        example: {
          javascript: "const es = new EventSource('/api/events');\nes.addEventListener('status', e => {\n  const { connection, qr } = JSON.parse(e.data);\n});",
        },
      },
      "POST /api/check": {
        description: "Check whether phone numbers are registered on WhatsApp. The server must be in 'connected' state.",
        request: {
          contentType: "application/json",
          body: {
            numbers: "string[] — phone numbers in E.164 format or digits only. Country code required. Max 100 per request.",
          },
          example: {
            numbers: ["+12025551234", "+447700900123", "+4915112345678", "5511987654321"],
          },
        },
        response: {
          id: "number — auto-incrementing session ID",
          total: "number — how many numbers were submitted",
          withWhatsapp: "number — count that have WhatsApp",
          withoutWhatsapp: "number — count that do not have WhatsApp",
          checkedAt: "ISO 8601 timestamp",
          results: "array — one entry per number (see NumberResult below)",
        },
        numberResult: {
          number: "string — the original value you submitted",
          formattedNumber: "string — normalized form used for the lookup (e.g. +12025551234)",
          hasWhatsapp: "boolean — true if the number is registered on WhatsApp",
          error: "string | null — null on success; a message if the number was invalid or unreachable",
        },
        successExample: {
          id: 3,
          total: 3,
          withWhatsapp: 2,
          withoutWhatsapp: 1,
          checkedAt: "2025-06-10T14:22:05.123Z",
          results: [
            { number: "+12025551234", formattedNumber: "+12025551234", hasWhatsapp: true, error: null },
            { number: "+447700900123", formattedNumber: "+447700900123", hasWhatsapp: false, error: null },
            { number: "bad-number", formattedNumber: "bad-number", hasWhatsapp: false, error: "Invalid number format" },
          ],
        },
        errors: [
          { status: 400, condition: "numbers field missing or empty", body: { error: "numbers must be a non-empty array" } },
          { status: 400, condition: "more than 100 numbers submitted", body: { error: "Maximum 100 numbers per request" } },
          { status: 503, condition: "WhatsApp not yet connected", body: { error: "WhatsApp not connected. Please scan the QR code first.", connection: "qr", qr: "data:image/png;base64,..." } },
        ],
      },
      "GET /api/history": {
        description: "List all past check sessions, newest first. Returns summaries only (no per-number results).",
        response: "Array of session objects",
        sessionObject: {
          id: "number",
          total: "number",
          withWhatsapp: "number",
          withoutWhatsapp: "number",
          checkedAt: "ISO 8601 string",
        },
        example: [
          { id: 4, total: 20, withWhatsapp: 15, withoutWhatsapp: 5, checkedAt: "2025-06-10T15:00:00.000Z" },
          { id: 3, total: 3, withWhatsapp: 2, withoutWhatsapp: 1, checkedAt: "2025-06-10T14:22:05.123Z" },
        ],
      },
      "GET /api/history/:id": {
        description: "Get the full result of a specific session including per-number results.",
        urlParam: "id — session ID returned by GET /api/history",
        response: "Full session object with results array (same shape as POST /api/check response)",
        errors: [
          { status: 404, body: { error: "Session not found" } },
        ],
      },
      "GET /api/stats": {
        description: "Cumulative statistics across all sessions.",
        response: {
          totalChecks: "number of sessions run",
          totalNumbersChecked: "total individual numbers checked across all sessions",
          totalWithWhatsapp: "number",
          totalWithoutWhatsapp: "number",
          successRate: "float — percentage of numbers that have WhatsApp (e.g. 74.5)",
        },
        example: {
          totalChecks: 12,
          totalNumbersChecked: 847,
          totalWithWhatsapp: 631,
          totalWithoutWhatsapp: 216,
          successRate: 74.5,
        },
      },
      "GET /api/healthz": {
        description: "Lightweight health check.",
        response: { status: "ok", connection: "connected" },
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[API] WhatsApp checker server running on port ${PORT}`);
});
