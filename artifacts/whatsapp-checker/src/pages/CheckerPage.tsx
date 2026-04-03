import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  checkNumbers,
  connectWhatsApp,
  disconnectWhatsApp,
  getHistory,
  getStats,
  getSession,
  getStatus,
  createStatusEventSource,
  type CheckSession,
  type NumberResult,
  type ConnectionState,
  type WAStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// ─── Small components ─────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4 flex flex-col gap-1 shadow-sm">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={cn("text-2xl font-bold", color ?? "text-foreground")}>{value}</span>
    </div>
  );
}

function ResultRow({ result }: { result: NumberResult }) {
  return (
    <div className={cn(
      "flex items-center justify-between px-4 py-3 rounded-lg border text-sm",
      result.error
        ? "bg-amber-50 border-amber-200"
        : result.hasWhatsapp
        ? "bg-green-50 border-green-200"
        : "bg-red-50 border-red-200"
    )}>
      <div className="flex flex-col gap-0.5">
        <span className="font-mono font-medium text-foreground">{result.formattedNumber}</span>
        {result.number !== result.formattedNumber && (
          <span className="text-xs text-muted-foreground">Original: {result.number}</span>
        )}
        {result.error && <span className="text-xs text-amber-700">{result.error}</span>}
      </div>
      <div className={cn(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold",
        result.error
          ? "bg-amber-100 text-amber-700"
          : result.hasWhatsapp
          ? "bg-green-100 text-green-700"
          : "bg-red-100 text-red-700"
      )}>
        {result.error ? <>⚠ Unknown</> : result.hasWhatsapp ? <>✓ Has WhatsApp</> : <>✗ No WhatsApp</>}
      </div>
    </div>
  );
}

function HistoryItem({ session, onView }: { session: CheckSession; onView: () => void }) {
  const rate = session.total > 0 ? Math.round((session.withWhatsapp / session.total) * 100) : 0;
  return (
    <button
      onClick={onView}
      className="w-full text-left bg-white rounded-lg border border-border p-3 hover:border-primary/50 hover:shadow-sm transition-all"
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{session.total} numbers checked</span>
          <span className="text-xs text-muted-foreground">{new Date(session.checkedAt).toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">{session.withWhatsapp} ✓</span>
          <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">{session.withoutWhatsapp} ✗</span>
          <span className="text-muted-foreground">{rate}%</span>
        </div>
      </div>
    </button>
  );
}

// ─── Connection Banner ────────────────────────────────────────────────────────

function ConnectionBanner({
  state,
  qr,
  onConnect,
  onDisconnect,
  connecting,
}: {
  state: ConnectionState;
  qr: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting: boolean;
}) {
  if (state === "connected") {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-3 mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-sm font-semibold text-green-800">WhatsApp Connected</span>
          <span className="text-xs text-green-600">— realtime status active</span>
        </div>
        <button
          onClick={onDisconnect}
          className="text-xs text-red-600 hover:text-red-800 font-medium border border-red-200 bg-white rounded-lg px-3 py-1 hover:bg-red-50 transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-4">
      {state === "qr" && qr ? (
        <div className="p-6 flex flex-col items-center gap-4">
          <div className="text-center">
            <h2 className="font-bold text-foreground text-lg">Connect Your WhatsApp</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              Open WhatsApp on your phone → tap <strong>Linked Devices</strong> → tap <strong>Link a Device</strong> → scan this QR code
            </p>
          </div>
          <div className="border-4 border-primary/20 rounded-2xl p-2 bg-white shadow-inner">
            <img src={qr} alt="WhatsApp QR code" className="w-56 h-56" />
          </div>
          <p className="text-xs text-muted-foreground">QR code refreshes automatically if it expires</p>
        </div>
      ) : (
        <div className="p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {connecting ? (
              <div className="w-7 h-7 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                <span className="text-gray-400 text-lg">●</span>
              </div>
            )}
            <div>
              <p className="text-sm font-semibold text-foreground">
                {state === "connecting"
                  ? "Connecting to WhatsApp…"
                  : state === "logged_out"
                  ? "WhatsApp logged out — reconnecting…"
                  : "WhatsApp not connected"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {state === "disconnected"
                  ? "Click Connect to link your WhatsApp account."
                  : "A QR code will appear shortly. You only need to scan it once."}
              </p>
            </div>
          </div>
          {(state === "disconnected" || state === "logged_out") && (
            <button
              onClick={onConnect}
              disabled={connecting}
              className="shrink-0 px-4 py-2 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50"
            >
              Connect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── API Docs ─────────────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="bg-gray-950 text-green-300 rounded-lg p-4 text-xs overflow-x-auto leading-relaxed font-mono whitespace-pre-wrap">
        {code}
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute top-2 right-2 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 px-2 py-0.5 rounded"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-blue-100 text-blue-700",
    POST: "bg-green-100 text-green-700",
    DELETE: "bg-red-100 text-red-700",
  };
  return (
    <span className={cn("text-xs font-bold px-2 py-0.5 rounded font-mono", colors[method] ?? "bg-gray-100 text-gray-700")}>
      {method}
    </span>
  );
}

function DocsPage() {
  const sections = [
    {
      method: "GET",
      path: "/api/status",
      title: "Connection Status",
      description: "Get the current WhatsApp connection state and QR code image.",
      response: `{
  "connection": "qr" | "connecting" | "connected" | "disconnected" | "logged_out",
  "qr": "data:image/png;base64,..." | null
}`,
      examples: [
        {
          label: "cURL",
          code: `curl https://your-domain/api/status`,
        },
        {
          label: "JavaScript (fetch)",
          code: `const res = await fetch('/api/status');
const { connection, qr } = await res.json();
console.log(connection); // "connected"`,
        },
        {
          label: "Python",
          code: `import requests
r = requests.get('https://your-domain/api/status')
print(r.json())  # {'connection': 'connected', 'qr': None}`,
        },
      ],
    },
    {
      method: "GET",
      path: "/api/events",
      title: "Realtime Status (SSE)",
      description: "Server-Sent Events stream. Pushes status updates instantly when the connection state changes. No polling required.",
      notes: ["Sends current state immediately on connect.", "Event name: status", "Keep-alive pings every 20 seconds."],
      response: `// Each event payload:
{
  "connection": "connected" | "qr" | "disconnected" | ...,
  "qr": "data:image/png;base64,..." | null
}`,
      examples: [
        {
          label: "JavaScript (EventSource)",
          code: `const es = new EventSource('/api/events');

es.addEventListener('status', (e) => {
  const { connection, qr } = JSON.parse(e.data);
  console.log('State:', connection);
  if (qr) {
    document.getElementById('qr').src = qr;
  }
});

// Clean up when done
// es.close();`,
        },
        {
          label: "Python (sseclient)",
          code: `import sseclient, requests

res = requests.get('https://your-domain/api/events', stream=True)
client = sseclient.SSEClient(res)

for event in client.events():
    if event.event == 'status':
        import json
        data = json.loads(event.data)
        print(data['connection'])`,
        },
      ],
    },
    {
      method: "POST",
      path: "/api/connect",
      title: "Connect",
      description: "Initiate or re-initiate a WhatsApp connection. After calling this, poll /api/events or /api/status to get the QR code.",
      requestBody: "None (empty body)",
      response: `{
  "message": "Connecting…",
  "connection": "connecting"
}`,
      examples: [
        {
          label: "cURL",
          code: `curl -X POST https://your-domain/api/connect`,
        },
        {
          label: "JavaScript",
          code: `const res = await fetch('/api/connect', { method: 'POST' });
const data = await res.json();
console.log(data.message); // "Connecting…"`,
        },
      ],
    },
    {
      method: "POST",
      path: "/api/disconnect",
      title: "Disconnect",
      description: "Log out from WhatsApp and clear the linked session. You will need to scan a new QR to reconnect.",
      requestBody: "None (empty body)",
      response: `{
  "message": "Disconnected",
  "connection": "disconnected"
}`,
      examples: [
        {
          label: "cURL",
          code: `curl -X POST https://your-domain/api/disconnect`,
        },
        {
          label: "JavaScript",
          code: `await fetch('/api/disconnect', { method: 'POST' });`,
        },
      ],
    },
    {
      method: "POST",
      path: "/api/check",
      title: "Check Numbers",
      description: "Check whether phone numbers are registered on WhatsApp. Requires the connection to be in 'connected' state. Numbers should include country code. Maximum 100 numbers per request.",
      requestBody: `{
  "numbers": ["+12345678900", "+447911123456", "4915212345678"]
}`,
      response: `{
  "id": 1,
  "total": 3,
  "withWhatsapp": 2,
  "withoutWhatsapp": 1,
  "checkedAt": "2025-01-15T10:30:00.000Z",
  "results": [
    {
      "number": "+12345678900",
      "formattedNumber": "+12345678900",
      "hasWhatsapp": true,
      "error": null
    },
    {
      "number": "+447911123456",
      "formattedNumber": "+447911123456",
      "hasWhatsapp": false,
      "error": null
    },
    {
      "number": "bad",
      "formattedNumber": "bad",
      "hasWhatsapp": false,
      "error": "Invalid number format"
    }
  ]
}`,
      errors: [
        { status: 400, body: `{ "error": "numbers must be a non-empty array" }` },
        { status: 400, body: `{ "error": "Maximum 100 numbers per request" }` },
        { status: 503, body: `{ "error": "WhatsApp not connected. Please scan the QR code first.", "connection": "qr", "qr": "data:image/png;base64,..." }` },
      ],
      examples: [
        {
          label: "cURL",
          code: `curl -X POST https://your-domain/api/check \\
  -H "Content-Type: application/json" \\
  -d '{"numbers":["+12345678900","+447911123456"]}'`,
        },
        {
          label: "JavaScript",
          code: `const res = await fetch('/api/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    numbers: ['+12345678900', '+447911123456']
  })
});

if (!res.ok) {
  const err = await res.json();
  throw new Error(err.error); // e.g. "WhatsApp not connected"
}

const session = await res.json();
session.results.forEach(r => {
  console.log(r.formattedNumber, r.hasWhatsapp ? '✓' : '✗');
});`,
        },
        {
          label: "Python",
          code: `import requests

r = requests.post('https://your-domain/api/check',
    json={'numbers': ['+12345678900', '+447911123456']})

if r.status_code != 200:
    print('Error:', r.json()['error'])
else:
    data = r.json()
    for result in data['results']:
        icon = '✓' if result['hasWhatsapp'] else '✗'
        print(f"{result['formattedNumber']} {icon}")`,
        },
      ],
    },
    {
      method: "GET",
      path: "/api/history",
      title: "Check History",
      description: "List all previous check sessions (summaries only). Sorted newest first.",
      response: `[
  {
    "id": 2,
    "total": 50,
    "withWhatsapp": 38,
    "withoutWhatsapp": 12,
    "checkedAt": "2025-01-15T10:45:00.000Z"
  },
  {
    "id": 1,
    "total": 10,
    "withWhatsapp": 7,
    "withoutWhatsapp": 3,
    "checkedAt": "2025-01-15T10:30:00.000Z"
  }
]`,
      examples: [
        {
          label: "cURL",
          code: `curl https://your-domain/api/history`,
        },
        {
          label: "JavaScript",
          code: `const sessions = await fetch('/api/history').then(r => r.json());
sessions.forEach(s => {
  console.log(\`Session \${s.id}: \${s.total} checked, \${s.withWhatsapp} have WhatsApp\`);
});`,
        },
      ],
    },
    {
      method: "GET",
      path: "/api/history/:id",
      title: "Session Detail",
      description: "Get the full result of a specific check session, including per-number results.",
      response: `{
  "id": 1,
  "total": 2,
  "withWhatsapp": 1,
  "withoutWhatsapp": 1,
  "checkedAt": "2025-01-15T10:30:00.000Z",
  "results": [
    { "number": "+12345678900", "formattedNumber": "+12345678900", "hasWhatsapp": true, "error": null },
    { "number": "+999000000", "formattedNumber": "+999000000", "hasWhatsapp": false, "error": null }
  ]
}`,
      errors: [{ status: 404, body: `{ "error": "Session not found" }` }],
      examples: [
        {
          label: "cURL",
          code: `curl https://your-domain/api/history/1`,
        },
        {
          label: "JavaScript",
          code: `const session = await fetch('/api/history/1').then(r => r.json());
console.log(session.results);`,
        },
      ],
    },
    {
      method: "GET",
      path: "/api/stats",
      title: "Aggregate Statistics",
      description: "Overall statistics aggregated across all sessions.",
      response: `{
  "totalChecks": 5,
  "totalNumbersChecked": 312,
  "totalWithWhatsapp": 241,
  "totalWithoutWhatsapp": 71,
  "successRate": 77.2
}`,
      examples: [
        {
          label: "cURL",
          code: `curl https://your-domain/api/stats`,
        },
        {
          label: "JavaScript",
          code: `const stats = await fetch('/api/stats').then(r => r.json());
console.log(\`WhatsApp rate: \${stats.successRate}%\`);`,
        },
      ],
    },
    {
      method: "GET",
      path: "/api/healthz",
      title: "Health Check",
      description: "Lightweight health check endpoint. Useful for uptime monitoring.",
      response: `{ "status": "ok", "connection": "connected" }`,
      examples: [
        {
          label: "cURL",
          code: `curl https://your-domain/api/healthz`,
        },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
        <h2 className="font-bold text-lg text-foreground">WhatsApp Checker API</h2>
        <p className="text-sm text-muted-foreground mt-1">
          REST API for checking WhatsApp registration status of phone numbers. Requires a linked WhatsApp account (scan once via QR).
          All endpoints return JSON. Base URL: <code className="bg-gray-100 px-1 rounded text-xs font-mono">/api</code>
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded">No auth required</span>
          <span className="bg-purple-50 text-purple-700 border border-purple-200 px-2 py-0.5 rounded">SSE realtime</span>
          <span className="bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded">Up to 100 numbers/request</span>
          <span className="bg-orange-50 text-orange-700 border border-orange-200 px-2 py-0.5 rounded">JSON responses</span>
        </div>
      </div>

      {sections.map((s) => (
        <div key={s.path} className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center gap-3">
            <MethodBadge method={s.method} />
            <code className="text-sm font-mono font-semibold text-foreground">{s.path}</code>
            <span className="text-sm text-muted-foreground">— {s.title}</span>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-sm text-muted-foreground">{s.description}</p>

            {s.notes && (
              <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                {s.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}

            {s.requestBody && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Request Body</h4>
                <CodeBlock code={s.requestBody} />
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Response</h4>
              <CodeBlock code={s.response} />
            </div>

            {s.errors && s.errors.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Error Responses</h4>
                <div className="space-y-2">
                  {s.errors.map((e, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="bg-red-100 text-red-700 text-xs font-mono font-bold px-1.5 py-0.5 rounded shrink-0">{e.status}</span>
                      <CodeBlock code={e.body} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Examples</h4>
              <div className="space-y-3">
                {s.examples.map((ex, i) => (
                  <div key={i}>
                    <p className="text-xs text-muted-foreground mb-1">{ex.label}</p>
                    <CodeBlock code={ex.code} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function CheckerPage() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<CheckSession | null>(null);
  const [activeTab, setActiveTab] = useState<"check" | "history" | "stats" | "api">("check");
  const [viewingSession, setViewingSession] = useState<number | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const queryClient = useQueryClient();

  // Bootstrap with HTTP fetch, then switch to SSE for realtime updates
  useEffect(() => {
    let cleanup: (() => void) | null = null;

    getStatus()
      .then((s) => {
        setConnectionState(s.connection);
        setQrCode(s.qr);
      })
      .catch(() => {})
      .finally(() => {
        cleanup = createStatusEventSource((s: WAStatus) => {
          setConnectionState(s.connection);
          setQrCode(s.qr);
        });
      });

    return () => cleanup?.();
  }, []);

  const { data: history = [] } = useQuery({
    queryKey: ["history"],
    queryFn: getHistory,
    enabled: activeTab === "history",
  });

  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    enabled: activeTab === "stats",
  });

  const { data: sessionDetail } = useQuery({
    queryKey: ["session", viewingSession],
    queryFn: () => getSession(viewingSession!),
    enabled: viewingSession !== null,
  });

  const mutation = useMutation({
    mutationFn: checkNumbers,
    onSuccess: (data) => {
      setResults(data);
      queryClient.invalidateQueries({ queryKey: ["history"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      toast.success(`Checked ${data.total} numbers — ${data.withWhatsapp} have WhatsApp`);
    },
    onError: (err: Error & { connection?: string; qr?: string }) => {
      if (err.connection && err.connection !== "connected") {
        toast.error("WhatsApp not connected — scan the QR code first");
      } else {
        toast.error(err.message || "Check failed");
      }
    },
  });

  async function handleConnect() {
    setActionPending(true);
    try {
      await connectWhatsApp();
      setConnectionState("connecting");
    } catch {
      toast.error("Failed to start connection");
    } finally {
      setActionPending(false);
    }
  }

  async function handleDisconnect() {
    setActionPending(true);
    try {
      await disconnectWhatsApp();
      setConnectionState("disconnected");
      toast.success("Disconnected from WhatsApp");
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setActionPending(false);
    }
  }

  function handleCheck() {
    const lines = input.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) { toast.error("Please enter at least one phone number"); return; }
    if (lines.length > 100) { toast.error("Maximum 100 numbers per check"); return; }
    if (connectionState !== "connected") { toast.error("WhatsApp not connected — scan the QR code first"); return; }
    setResults(null);
    mutation.mutate(lines);
  }

  function handleExportCSV(session: CheckSession) {
    if (!session.results) return;
    const rows = [["Number", "Formatted", "Has WhatsApp", "Error"]];
    session.results.forEach((r) => {
      rows.push([r.number, r.formattedNumber, r.hasWhatsapp ? "Yes" : "No", r.error ?? ""]);
    });
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `whatsapp-check-${session.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const statusDot = connectionState === "connected"
    ? "bg-green-500 animate-pulse"
    : connectionState === "qr"
    ? "bg-amber-500 animate-pulse"
    : connectionState === "connecting"
    ? "bg-blue-400 animate-ping"
    : "bg-gray-400";

  const statusLabel = connectionState === "connected"
    ? "Connected"
    : connectionState === "qr"
    ? "Scan QR"
    : connectionState === "connecting"
    ? "Connecting…"
    : connectionState === "logged_out"
    ? "Logged out"
    : "Disconnected";

  const statusColor = connectionState === "connected"
    ? "bg-green-100 text-green-700"
    : connectionState === "qr"
    ? "bg-amber-100 text-amber-700"
    : connectionState === "connecting"
    ? "bg-blue-50 text-blue-600"
    : "bg-gray-100 text-gray-500";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center text-white text-lg font-bold shadow">
            W
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-foreground leading-none">WhatsApp Checker</h1>
            <p className="text-xs text-muted-foreground">Verify which numbers have WhatsApp</p>
          </div>
          {/* Realtime status pill */}
          <div className={cn("flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full", statusColor)}>
            <span className={cn("w-1.5 h-1.5 rounded-full", statusDot)} />
            {statusLabel}
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-3xl mx-auto px-4 flex gap-0 border-t border-border">
          {(["check", "history", "stats", "api"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setViewingSession(null); }}
              className={cn(
                "px-5 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === "api" ? "API Docs" : tab}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-0">
        {/* Connection banner — always visible when not on docs tab */}
        {activeTab !== "api" && (
          <ConnectionBanner
            state={connectionState}
            qr={qrCode}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            connecting={actionPending || connectionState === "connecting"}
          />
        )}

        {/* CHECK TAB */}
        {activeTab === "check" && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
              <div>
                <h2 className="font-semibold text-foreground">Enter phone numbers</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  One per line, with country code (e.g. +1 234 567 8900). Up to 100 numbers.
                </p>
              </div>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={"+1 234 567 8900\n+44 20 7946 0958\n+49 30 1234567\n+55 11 91234-5678"}
                className="w-full h-44 rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {input.split(/[\n,;]+/).filter((l) => l.trim()).length} numbers entered
                </span>
                <button
                  onClick={handleCheck}
                  disabled={mutation.isPending || !input.trim() || connectionState !== "connected"}
                  className={cn(
                    "px-5 py-2.5 rounded-lg font-semibold text-sm text-primary-foreground transition-all",
                    mutation.isPending || !input.trim() || connectionState !== "connected"
                      ? "bg-primary/50 cursor-not-allowed"
                      : "bg-primary hover:bg-primary/90 shadow-sm active:scale-95"
                  )}
                >
                  {mutation.isPending ? "Checking…" : "Check Numbers"}
                </button>
              </div>
            </div>

            {mutation.isPending && (
              <div className="bg-accent/60 rounded-xl border border-accent-foreground/10 p-4 flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Checking numbers via WhatsApp…</p>
                  <p className="text-xs text-muted-foreground">Results are live — may take a moment for large lists</p>
                </div>
              </div>
            )}

            {results && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <StatCard label="Total" value={results.total} />
                  <StatCard label="Has WhatsApp" value={results.withWhatsapp} color="text-green-600" />
                  <StatCard label="No WhatsApp" value={results.withoutWhatsapp} color="text-red-500" />
                </div>
                <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">Results</h3>
                    <button onClick={() => handleExportCSV(results)} className="text-xs text-primary hover:underline font-medium">
                      Export CSV
                    </button>
                  </div>
                  <div className="space-y-2">
                    {results.results?.map((r, i) => <ResultRow key={i} result={r} />)}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === "history" && (
          <div className="space-y-4">
            {viewingSession !== null && sessionDetail ? (
              <div className="space-y-3">
                <button onClick={() => setViewingSession(null)} className="text-sm text-primary hover:underline font-medium">
                  ← Back to history
                </button>
                <div className="grid grid-cols-3 gap-3">
                  <StatCard label="Total" value={sessionDetail.total} />
                  <StatCard label="Has WhatsApp" value={sessionDetail.withWhatsapp} color="text-green-600" />
                  <StatCard label="No WhatsApp" value={sessionDetail.withoutWhatsapp} color="text-red-500" />
                </div>
                <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">Session #{sessionDetail.id}</h3>
                    <button onClick={() => handleExportCSV(sessionDetail)} className="text-xs text-primary hover:underline font-medium">
                      Export CSV
                    </button>
                  </div>
                  <div className="space-y-2">
                    {sessionDetail.results?.map((r, i) => <ResultRow key={i} result={r} />)}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <h2 className="font-semibold text-foreground">Check history</h2>
                {history.length === 0 ? (
                  <div className="bg-white rounded-xl border border-border p-10 text-center text-muted-foreground text-sm shadow-sm">
                    No checks yet. Run your first check above.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {history.map((s) => <HistoryItem key={s.id} session={s} onView={() => setViewingSession(s.id)} />)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* STATS TAB */}
        {activeTab === "stats" && (
          <div className="space-y-4">
            <h2 className="font-semibold text-foreground">Overall statistics</h2>
            {stats ? (
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Total checks" value={stats.totalChecks} />
                <StatCard label="Numbers checked" value={stats.totalNumbersChecked} />
                <StatCard label="With WhatsApp" value={stats.totalWithWhatsapp} color="text-green-600" />
                <StatCard label="Without WhatsApp" value={stats.totalWithoutWhatsapp} color="text-red-500" />
                <div className="col-span-2">
                  <StatCard label="WhatsApp rate" value={`${stats.successRate}%`} color="text-primary" />
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-border p-10 text-center text-muted-foreground text-sm shadow-sm">
                No statistics yet. Run your first check.
              </div>
            )}
          </div>
        )}

        {/* API DOCS TAB */}
        {activeTab === "api" && <DocsPage />}
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-xs text-muted-foreground text-center">
          Checks numbers directly via your linked WhatsApp account. Use responsibly and in compliance with applicable laws.
        </p>
      </div>
    </div>
  );
}
