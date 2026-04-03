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
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("[WA] Connection closed, reconnecting:", shouldReconnect);
      waClient = null;
      if (shouldReconnect) {
        setConnectionState("disconnected");
        setTimeout(startWhatsApp, 3000);
      } else {
        setConnectionState("logged_out");
        const { rmSync } = await import("fs");
        try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        mkdirSync(AUTH_DIR, { recursive: true });
        setTimeout(startWhatsApp, 2000);
      }
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

// ─── Connect / Disconnect ────────────────────────────────────────────────────

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

app.post("/api/disconnect", async (req, res) => {
  if (!waClient) {
    return res.json({ message: "Not connected", connection: connectionState });
  }
  try {
    await waClient.logout();
  } catch (_) {
    try { await waClient.end(); } catch (_) {}
  }
  waClient = null;
  setConnectionState("disconnected");
  res.json({ message: "Disconnected", connection: "disconnected" });
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
    title: "WhatsApp Checker API",
    version: "1.0.0",
    baseUrl: "/api",
    description: "Check whether phone numbers are registered on WhatsApp using a linked WhatsApp account via Baileys.",
    authentication: "None — runs as a local server linked to your WhatsApp account via QR scan.",
    endpoints: [
      {
        method: "GET",
        path: "/api/status",
        description: "Get current WhatsApp connection status and QR code (if pending).",
        response: {
          schema: {
            connection: "string — one of: disconnected | connecting | qr | connected | logged_out",
            qr: "string | null — base64 data URL of QR code image (only present when connection === 'qr')",
          },
          example: {
            connection: "qr",
            qr: "data:image/png;base64,iVBORw0KGgo...",
          },
        },
      },
      {
        method: "GET",
        path: "/api/events",
        description: "Real-time Server-Sent Events stream for connection status changes. Connect with EventSource.",
        notes: [
          "Content-Type: text/event-stream",
          "Event name: 'status'",
          "Sends current state immediately on connect, then pushes updates in real time.",
          "Sends keep-alive pings every 20 seconds.",
        ],
        example: {
          code: `const es = new EventSource('/api/events');\nes.addEventListener('status', e => {\n  const { connection, qr } = JSON.parse(e.data);\n  console.log(connection, qr);\n});`,
        },
        eventPayload: {
          connection: "string — current connection state",
          qr: "string | null — base64 QR data URL or null",
        },
      },
      {
        method: "POST",
        path: "/api/connect",
        description: "Initiate or re-initiate WhatsApp connection. Safe to call when already connecting.",
        requestBody: "None",
        response: {
          schema: {
            message: "string — human-readable status",
            connection: "string — new connection state",
          },
          example: { message: "Connecting…", connection: "connecting" },
        },
      },
      {
        method: "POST",
        path: "/api/disconnect",
        description: "Log out and disconnect from WhatsApp. Clears the linked session.",
        requestBody: "None",
        response: {
          schema: {
            message: "string",
            connection: "string — will be 'disconnected'",
          },
          example: { message: "Disconnected", connection: "disconnected" },
        },
      },
      {
        method: "POST",
        path: "/api/check",
        description: "Check whether one or more phone numbers are registered on WhatsApp. Requires connection state to be 'connected'.",
        requestBody: {
          schema: {
            numbers: "string[] — list of phone numbers (E.164 or digits only). Max 100 per request.",
          },
          example: {
            numbers: ["+12345678900", "+447911123456", "4915212345678"],
          },
        },
        response: {
          schema: {
            id: "number — session ID",
            total: "number — total numbers checked",
            withWhatsapp: "number — count with WhatsApp",
            withoutWhatsapp: "number — count without WhatsApp",
            checkedAt: "string — ISO 8601 timestamp",
            results: "NumberResult[] — per-number results",
          },
          numberResult: {
            number: "string — original input",
            formattedNumber: "string — normalized E.164 format",
            hasWhatsapp: "boolean",
            error: "string | null — error message if check failed",
          },
          example: {
            id: 1,
            total: 2,
            withWhatsapp: 1,
            withoutWhatsapp: 1,
            checkedAt: "2025-01-15T10:30:00.000Z",
            results: [
              { number: "+12345678900", formattedNumber: "+12345678900", hasWhatsapp: true, error: null },
              { number: "+999000000", formattedNumber: "+999000000", hasWhatsapp: false, error: null },
            ],
          },
        },
        errors: [
          { status: 400, body: { error: "numbers must be a non-empty array" } },
          { status: 400, body: { error: "Maximum 100 numbers per request" } },
          { status: 503, body: { error: "WhatsApp not connected. Please scan the QR code first.", connection: "qr", qr: "data:image/png;base64,..." } },
        ],
      },
      {
        method: "GET",
        path: "/api/history",
        description: "List all past check sessions (summary only, no individual results).",
        response: {
          schema: "CheckSession[] — array of session summaries, newest first",
          sessionSummary: {
            id: "number",
            total: "number",
            withWhatsapp: "number",
            withoutWhatsapp: "number",
            checkedAt: "string — ISO 8601",
          },
          example: [
            { id: 2, total: 50, withWhatsapp: 38, withoutWhatsapp: 12, checkedAt: "2025-01-15T10:45:00.000Z" },
            { id: 1, total: 10, withWhatsapp: 7, withoutWhatsapp: 3, checkedAt: "2025-01-15T10:30:00.000Z" },
          ],
        },
      },
      {
        method: "GET",
        path: "/api/history/:id",
        description: "Get full details for a specific check session including per-number results.",
        params: { id: "number — session ID from /api/history" },
        response: {
          description: "Full CheckSession object including results array.",
          example: {
            id: 1,
            total: 2,
            withWhatsapp: 1,
            withoutWhatsapp: 1,
            checkedAt: "2025-01-15T10:30:00.000Z",
            results: [
              { number: "+12345678900", formattedNumber: "+12345678900", hasWhatsapp: true, error: null },
            ],
          },
        },
        errors: [{ status: 404, body: { error: "Session not found" } }],
      },
      {
        method: "GET",
        path: "/api/stats",
        description: "Aggregate statistics across all check sessions.",
        response: {
          schema: {
            totalChecks: "number — number of check sessions",
            totalNumbersChecked: "number — total individual numbers checked",
            totalWithWhatsapp: "number",
            totalWithoutWhatsapp: "number",
            successRate: "number — percentage (0–100) of numbers with WhatsApp",
          },
          example: {
            totalChecks: 5,
            totalNumbersChecked: 312,
            totalWithWhatsapp: 241,
            totalWithoutWhatsapp: 71,
            successRate: 77.2,
          },
        },
      },
      {
        method: "GET",
        path: "/api/healthz",
        description: "Health check endpoint.",
        response: { example: { status: "ok", connection: "connected" } },
      },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[API] WhatsApp checker server running on port ${PORT}`);
});
