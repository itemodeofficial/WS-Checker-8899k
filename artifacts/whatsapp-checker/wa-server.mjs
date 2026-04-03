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
let connectionState = "disconnected"; // disconnected | qr | connecting | connected
let checkHistory = [];
let sessionCounter = 0;

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
  connectionState = "connecting";

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const QRCode = await import("qrcode");
      qrCode = await QRCode.toDataURL(qr);
      connectionState = "qr";
      console.log("[WA] QR code ready — scan to authenticate");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("[WA] Connection closed, reconnecting:", shouldReconnect);
      qrCode = null;
      waClient = null;
      if (shouldReconnect) {
        connectionState = "disconnected";
        setTimeout(startWhatsApp, 3000);
      } else {
        connectionState = "logged_out";
        // Clear auth on logout
        const { rmSync } = await import("fs");
        try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        mkdirSync(AUTH_DIR, { recursive: true });
        setTimeout(startWhatsApp, 2000);
      }
    }

    if (connection === "open") {
      console.log("[WA] Connected successfully");
      qrCode = null;
      connectionState = "connected";
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}

startWhatsApp().catch(console.error);

// --- API Routes ---

app.get("/api/healthz", (req, res) => {
  res.json({ status: "ok", connection: connectionState });
});

app.get("/api/status", (req, res) => {
  res.json({
    connection: connectionState,
    qr: connectionState === "qr" ? qrCode : null,
  });
});

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
      const jid = `${digits}@s.whatsapp.net`;
      const [result] = await waClient.onWhatsApp(digits);

      if (result?.exists) {
        results.push({
          number: String(raw),
          formattedNumber: `+${digits}`,
          hasWhatsapp: true,
          error: null,
        });
        withWhatsapp++;
      } else {
        results.push({
          number: String(raw),
          formattedNumber: `+${digits}`,
          hasWhatsapp: false,
          error: null,
        });
        withoutWhatsapp++;
      }
    } catch (err) {
      results.push({
        number: String(raw),
        formattedNumber: `+${digits}`,
        hasWhatsapp: false,
        error: "Could not determine (network issue)",
      });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[API] WhatsApp checker server running on port ${PORT}`);
});
