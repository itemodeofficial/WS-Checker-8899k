import { useState, useEffect, useRef } from "react";
import { QrCode, RefreshCw, Wifi, WifiOff, Trash2, Download, LogOut } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  checkNumbers,
  connectWhatsApp,
  disconnectWhatsApp,
  forceQR,
  getHistory,
  getStats,
  getSession,
  getStatus,
  deleteSession,
  clearHistory,
  createStatusEventSource,
  type CheckSession,
  type NumberResult,
  type ConnectionState,
  type WAStatus,
  type ProgressUpdate,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4 flex flex-col gap-1 shadow-sm">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={cn("text-2xl font-bold", color ?? "text-foreground")}>{value}</span>
    </div>
  );
}

// ─── Result Row ───────────────────────────────────────────────────────────────

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
        "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0",
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

// ─── History Item ─────────────────────────────────────────────────────────────

function HistoryItem({
  session,
  onView,
  onDelete,
}: {
  session: CheckSession;
  onView: () => void;
  onDelete: () => void;
}) {
  const rate = session.total > 0 ? Math.round((session.withWhatsapp / session.total) * 100) : 0;
  return (
    <div className="w-full bg-white rounded-lg border border-border p-3 hover:border-primary/40 hover:shadow-sm transition-all flex items-center gap-2">
      <button onClick={onView} className="flex-1 text-left">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{session.total} numbers checked</span>
            <span className="text-xs text-muted-foreground">{new Date(session.checkedAt).toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-2 text-xs mr-2">
            <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">{session.withWhatsapp} ✓</span>
            <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">{session.withoutWhatsapp} ✗</span>
            <span className="text-muted-foreground">{rate}%</span>
          </div>
        </div>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors"
        title="Delete session"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

function ProgressBar({ progress }: { progress: ProgressUpdate | null }) {
  if (!progress || progress.total === 0) return null;
  const pct = Math.round((progress.checked / progress.total) * 100);

  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-2">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
          <span className="font-medium text-foreground">
            Checking {progress.checked} / {progress.total}
          </span>
        </div>
        <span className="text-xs font-bold text-primary">{pct}%</span>
      </div>
      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.current && (
        <p className="text-xs text-muted-foreground font-mono truncate">
          Checking: {progress.current}
          {progress.withWA !== undefined && (
            <span className="ml-2 text-green-600 font-medium">✓ {progress.withWA}</span>
          )}
          {progress.withoutWA !== undefined && (
            <span className="ml-1 text-red-500 font-medium">✗ {progress.withoutWA}</span>
          )}
        </p>
      )}
    </div>
  );
}

// ─── Connection Banner ────────────────────────────────────────────────────────

function ConnectionBanner({
  state,
  qrVersion,
  onConnect,
  onDisconnect,
  connecting,
  disconnecting,
}: {
  state: ConnectionState;
  qrVersion: number;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting: boolean;
  disconnecting: boolean;
}) {
  if (state === "connected") {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-3 mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
          <span className="text-sm font-semibold text-green-800">WhatsApp Connected</span>
          <span className="text-xs text-green-600 hidden sm:inline">— realtime updates active</span>
        </div>
        <button
          onClick={onDisconnect}
          disabled={disconnecting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 bg-white text-red-600 hover:bg-red-50 active:scale-95 transition-all disabled:opacity-50 shrink-0"
        >
          <LogOut className="w-3.5 h-3.5" />
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-4">
      {state === "qr" && qrVersion > 0 ? (
        <div className="p-6 flex flex-col items-center gap-4">
          <div className="text-center">
            <h2 className="font-bold text-foreground text-lg">Connect Your WhatsApp</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              Open WhatsApp → tap <strong>Linked Devices</strong> → <strong>Link a Device</strong> → scan QR
            </p>
            <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5 mt-2 inline-block">
              One-time scan — session stays active permanently
            </p>
          </div>
          <div className="border-4 border-primary/20 rounded-2xl p-2 bg-white shadow-inner">
            <img
              key={qrVersion}
              src={`/api/qr?v=${qrVersion}`}
              alt="WhatsApp QR code"
              className="w-72 h-72"
            />
          </div>
          <p className="text-xs text-muted-foreground">QR code refreshes automatically if expired</p>
        </div>
      ) : (
        <div className="p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {connecting ? (
              <div className="w-7 h-7 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
            ) : (
              <WifiOff className="w-6 h-6 text-gray-400 shrink-0" />
            )}
            <div>
              <p className="text-sm font-semibold text-foreground">
                {state === "connecting" ? "Connecting to WhatsApp…"
                  : state === "logged_out" ? "Session expired"
                  : "WhatsApp not connected"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {state === "disconnected"
                  ? "Click Connect to link your WhatsApp account."
                  : "QR code will appear shortly."}
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

function DocSection({
  method, path, badge, description, children,
}: {
  method: string; path: string; badge?: string; description: string; children: React.ReactNode;
}) {
  const methodColor = method === "POST"
    ? "bg-green-100 text-green-700"
    : method === "DELETE"
    ? "bg-red-100 text-red-700"
    : "bg-blue-100 text-blue-700";
  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-3 flex-wrap">
        <span className={cn("text-xs font-bold px-2 py-0.5 rounded font-mono shrink-0", methodColor)}>{method}</span>
        <code className="text-sm font-mono font-semibold text-foreground">{path}</code>
        {badge && <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-medium">{badge}</span>}
      </div>
      <div className="p-5 space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
        {children}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">{children}</h4>;
}

function SchemaTable({ rows }: { rows: { field: string; type: string; note: string }[] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden text-xs">
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-border">
          <tr>
            <th className="text-left px-3 py-2 font-semibold text-foreground w-1/4">Field</th>
            <th className="text-left px-3 py-2 font-semibold text-foreground w-1/4">Type</th>
            <th className="text-left px-3 py-2 font-semibold text-foreground">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
              <td className="px-3 py-2 font-mono text-foreground font-medium">{r.field}</td>
              <td className="px-3 py-2 font-mono text-blue-600">{r.type}</td>
              <td className="px-3 py-2 text-muted-foreground">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorRow({ status, condition, body }: { status: number; condition: string; body: string }) {
  return (
    <div className="rounded-lg border border-red-100 overflow-hidden text-xs">
      <div className="bg-red-50 border-b border-red-100 px-3 py-1.5 flex items-center gap-2">
        <span className="bg-red-200 text-red-800 font-mono font-bold px-1.5 py-0.5 rounded">{status}</span>
        <span className="text-red-700">{condition}</span>
      </div>
      <CodeBlock code={body} />
    </div>
  );
}

function DocsPage() {
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
        <h2 className="font-bold text-lg text-foreground">WhatsApp Number Checker API</h2>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
          REST API for checking whether phone numbers are registered on WhatsApp.
          Base URL: <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">/api</code>
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded">One-time login</span>
          <span className="bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded">SSE realtime progress</span>
          <span className="bg-purple-50 text-purple-700 border border-purple-200 px-2 py-0.5 rounded">Rate limited</span>
          <span className="bg-orange-50 text-orange-700 border border-orange-200 px-2 py-0.5 rounded">Up to 100 numbers/request</span>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
        <h3 className="font-semibold text-foreground">Quick Start</h3>
        <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside leading-relaxed">
          <li>Check <code className="bg-gray-100 px-1 rounded text-xs font-mono">GET /api/status</code> — if <code className="bg-gray-100 px-1 rounded text-xs font-mono">connection</code> is <code className="bg-gray-100 px-1 rounded text-xs font-mono">"qr"</code>, display the QR and scan it.</li>
          <li>Wait for <code className="bg-gray-100 px-1 rounded text-xs font-mono">connection === "connected"</code> via SSE.</li>
          <li>Call <code className="bg-gray-100 px-1 rounded text-xs font-mono">POST /api/check</code> with your numbers.</li>
          <li>Subscribe to <code className="bg-gray-100 px-1 rounded text-xs font-mono">GET /api/events</code> for live progress.</li>
        </ol>
        <Label>JavaScript example</Label>
        <CodeBlock code={`const es = new EventSource('/api/events');

// Listen for real-time progress
es.addEventListener('progress', e => {
  const { checked, total, withWA } = JSON.parse(e.data);
  console.log(\`\${checked}/\${total} checked, \${withWA} have WhatsApp\`);
});

// Check numbers
const res = await fetch('/api/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ numbers: ['+880123456789', '+1234567890'] })
});
const session = await res.json();
session.results.forEach(r =>
  console.log(r.formattedNumber, r.hasWhatsapp ? '✓' : '✗')
);`} />
      </div>

      <DocSection method="GET" path="/api/check/:number" badge="Single check"
        description="Check one number via URL. Include country code.">
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl "http://YOUR_VPS_IP:3000/api/check/+8801234567890"
curl "http://YOUR_VPS_IP:3000/api/check/8801234567890"`} />
        </div>
        <div>
          <Label>Response</Label>
          <CodeBlock code={`{ "number": "+8801234567890", "formattedNumber": "+8801234567890", "hasWhatsapp": true, "error": null }`} />
        </div>
      </DocSection>

      <DocSection method="POST" path="/api/check" badge="Batch (up to 100)"
        description="Check multiple numbers. Progress is broadcast in real-time via /api/events SSE. Max 100 per request. Rate limited to 30 req/min.">
        <div>
          <Label>Request</Label>
          <CodeBlock code={`curl -X POST http://YOUR_VPS_IP:3000/api/check \\
  -H "Content-Type: application/json" \\
  -d '{"numbers":["+8801234567890","+447700900123"]}'`} />
        </div>
        <div>
          <Label>Response</Label>
          <CodeBlock code={`{
  "id": 3, "total": 2, "withWhatsapp": 1, "withoutWhatsapp": 1,
  "checkedAt": "2025-06-10T14:22:05.123Z",
  "results": [
    { "number": "+8801234567890", "formattedNumber": "+8801234567890", "hasWhatsapp": true, "error": null },
    { "number": "+447700900123",  "formattedNumber": "+447700900123",  "hasWhatsapp": false, "error": null }
  ]
}`} />
        </div>
        <div>
          <Label>Python</Label>
          <CodeBlock code={`import requests

r = requests.post('http://YOUR_VPS_IP:3000/api/check',
    json={'numbers': ['+8801234567890', '+447700900123']})

data = r.json()
print(f"Session {data['id']}: {data['withWhatsapp']}/{data['total']} have WhatsApp")
for result in data['results']:
    print(('✓' if result['hasWhatsapp'] else '✗'), result['formattedNumber'])`} />
        </div>
      </DocSection>

      <DocSection method="GET" path="/api/events"
        description="Server-Sent Events. Sends 'status' events for connection changes and 'progress' events during batch checks.">
        <div>
          <Label>Progress event data</Label>
          <SchemaTable rows={[
            { field: "checked", type: "number", note: "How many numbers checked so far" },
            { field: "total", type: "number", note: "Total numbers in this batch" },
            { field: "current", type: "string", note: "The number currently being checked" },
            { field: "withWA", type: "number", note: "Count with WhatsApp so far" },
            { field: "withoutWA", type: "number", note: "Count without WhatsApp so far" },
            { field: "done", type: "boolean", note: "true when batch is complete" },
          ]} />
        </div>
      </DocSection>

      <DocSection method="GET" path="/api/status" description="Current connection state.">
        <div>
          <Label>Response</Label>
          <CodeBlock code={`{ "connection": "connected", "qrVersion": 0 }`} />
        </div>
      </DocSection>

      <DocSection method="GET" path="/api/healthz" description="Health check. Returns uptime, memory, SSE client count.">
        <div>
          <Label>Response</Label>
          <CodeBlock code={`{ "status": "ok", "connection": "connected", "uptime": 3600, "memory": "120MB", "clients": 2 }`} />
        </div>
      </DocSection>

      <DocSection method="DELETE" path="/api/history/:id" description="Delete a single check session from the database.">
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl -X DELETE http://YOUR_VPS_IP:3000/api/history/3`} />
        </div>
      </DocSection>

      <DocSection method="DELETE" path="/api/history" description="Clear all check history from the database.">
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl -X DELETE http://YOUR_VPS_IP:3000/api/history`} />
        </div>
      </DocSection>

      <DocSection method="POST" path="/api/disconnect" description="Manually disconnect WhatsApp session (does not wipe credentials).">
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl -X POST http://YOUR_VPS_IP:3000/api/disconnect`} />
        </div>
      </DocSection>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CheckerPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"check" | "history" | "stats" | "api">("check");
  const [input, setInput] = useState("");
  const [results, setResults] = useState<(CheckSession & { results?: NumberResult[] }) | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [qrVersion, setQrVersion] = useState(0);
  const [connectPending, setConnectPending] = useState(false);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [forceQrPending, setForceQrPending] = useState(false);
  const [viewingSession, setViewingSession] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const sseCleanupRef = useRef<(() => void) | null>(null);

  // Live number count
  const numberCount = input.split(/[\n,;]+/).filter((l) => l.trim()).length;

  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const s = await getStatus();
        setConnectionState(s.connection);
        if (s.qrVersion > 0) setQrVersion(s.qrVersion);
      } catch (_) {}
    }

    poll().then(() => {
      const cleanup = createStatusEventSource(
        (s: WAStatus) => {
          setConnectionState(s.connection);
          if (s.qrVersion > 0) setQrVersion(s.qrVersion);
        },
        (p: ProgressUpdate) => {
          setProgress(p.done ? null : p);
        }
      );
      sseCleanupRef.current = cleanup;
      pollTimer = setInterval(poll, 8000);
    });

    return () => {
      sseCleanupRef.current?.();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  const { data: history = [], refetch: refetchHistory } = useQuery({
    queryKey: ["history"],
    queryFn: getHistory,
    enabled: activeTab === "history",
  });

  const { data: stats, refetch: refetchStats } = useQuery({
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
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["history"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      toast.success(`Checked ${data.total} numbers — ${data.withWhatsapp} have WhatsApp`);
    },
    onError: (err: Error & { connection?: string }) => {
      setProgress(null);
      if (err.connection && err.connection !== "connected") {
        toast.error("WhatsApp not connected — scan the QR code first");
      } else {
        toast.error(err.message || "Check failed");
      }
    },
  });

  async function handleConnect() {
    setConnectPending(true);
    try {
      await connectWhatsApp();
      setConnectionState("connecting");
    } catch {
      toast.error("Failed to start connection");
    } finally {
      setConnectPending(false);
    }
  }

  async function handleDisconnect() {
    setDisconnectPending(true);
    try {
      await disconnectWhatsApp();
      setConnectionState("disconnected");
      toast.success("WhatsApp disconnected");
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setDisconnectPending(false);
    }
  }

  async function handleForceQR() {
    setForceQrPending(true);
    try {
      await forceQR();
      setConnectionState("connecting");
      toast.success("Generating fresh QR code…");
    } catch {
      toast.error("Failed to generate QR code");
    } finally {
      setForceQrPending(false);
    }
  }

  function handleCheck() {
    const lines = input.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) { toast.error("Please enter at least one phone number"); return; }
    if (lines.length > 100) { toast.error("Maximum 100 numbers per check"); return; }
    if (connectionState !== "connected") { toast.error("WhatsApp not connected — scan the QR code first"); return; }
    setResults(null);
    setProgress({ checked: 0, total: lines.length });
    mutation.mutate(lines);
  }

  async function handleDeleteSession(id: number) {
    try {
      await deleteSession(id);
      toast.success("Session deleted");
      queryClient.invalidateQueries({ queryKey: ["history"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      if (viewingSession === id) setViewingSession(null);
    } catch {
      toast.error("Failed to delete session");
    }
  }

  async function handleClearHistory() {
    if (!confirm("Clear all check history? This cannot be undone.")) return;
    try {
      await clearHistory();
      toast.success("All history cleared");
      queryClient.invalidateQueries({ queryKey: ["history"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      setViewingSession(null);
    } catch {
      toast.error("Failed to clear history");
    }
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
    a.download = `wa-check-${session.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Header status pill
  const statusDot = connectionState === "connected"
    ? "bg-green-500 animate-pulse"
    : connectionState === "qr"
    ? "bg-amber-500 animate-pulse"
    : connectionState === "connecting"
    ? "bg-blue-400 animate-ping"
    : "bg-gray-400";

  const statusLabel = connectionState === "connected" ? "Connected"
    : connectionState === "qr" ? "Scan QR"
    : connectionState === "connecting" ? "Connecting…"
    : connectionState === "logged_out" ? "Logged out"
    : "Disconnected";

  const statusColor = connectionState === "connected" ? "bg-green-100 text-green-700"
    : connectionState === "qr" ? "bg-amber-100 text-amber-700"
    : connectionState === "connecting" ? "bg-blue-50 text-blue-600"
    : "bg-gray-100 text-gray-500";

  return (
    <div className="min-h-screen bg-background">

      {/* Header */}
      <div className="bg-white border-b border-border sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center text-white text-lg font-bold shadow shrink-0">
            W
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-foreground leading-none">WhatsApp Checker</h1>
            <p className="text-xs text-muted-foreground hidden sm:block">Verify which numbers have WhatsApp</p>
          </div>

          {/* Status pill */}
          <div className={cn("flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full shrink-0", statusColor)}>
            <span className={cn("w-1.5 h-1.5 rounded-full", statusDot)} />
            {statusLabel}
          </div>

          {/* New QR button */}
          <button
            onClick={handleForceQR}
            disabled={forceQrPending}
            title="Generate new QR code"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border bg-white text-foreground hover:bg-accent hover:border-primary/40 active:scale-95 transition-all disabled:opacity-50 shrink-0"
          >
            {forceQrPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <QrCode className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">New QR</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="max-w-3xl mx-auto px-4 flex gap-0 border-t border-border">
          {(["check", "history", "stats", "api"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setViewingSession(null); }}
              className={cn(
                "px-4 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
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

      <div className="max-w-3xl mx-auto px-4 py-6">

        {/* Connection banner */}
        {activeTab !== "api" && (
          <ConnectionBanner
            state={connectionState}
            qrVersion={qrVersion}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            connecting={connectPending || connectionState === "connecting"}
            disconnecting={disconnectPending}
          />
        )}

        {/* CHECK TAB */}
        {activeTab === "check" && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
              <div>
                <h2 className="font-semibold text-foreground">Enter phone numbers</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  One per line, with country code (e.g. +880 1234 567890). Up to 100 numbers.
                </p>
              </div>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={"+880 1234 567890\n+1 234 567 8900\n+44 20 7946 0958\n+49 30 1234567"}
                className="w-full h-44 rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {numberCount} number{numberCount !== 1 ? "s" : ""} entered
                  {numberCount > 0 && (
                    <span className="ml-1 text-muted-foreground/70">
                      (~{Math.ceil(numberCount * 0.3)}s estimated)
                    </span>
                  )}
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

            {/* Progress bar (live during check) */}
            {mutation.isPending && <ProgressBar progress={progress} />}

            {/* Results */}
            {results && !mutation.isPending && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <StatCard label="Total" value={results.total} />
                  <StatCard label="Has WhatsApp" value={results.withWhatsapp} color="text-green-600" />
                  <StatCard label="No WhatsApp" value={results.withoutWhatsapp} color="text-red-500" />
                </div>
                <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">Results</h3>
                    <button
                      onClick={() => handleExportCSV(results)}
                      className="flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
                    >
                      <Download className="w-3.5 h-3.5" />
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
                <div className="flex items-center justify-between">
                  <button onClick={() => setViewingSession(null)} className="text-sm text-primary hover:underline font-medium">
                    ← Back to history
                  </button>
                  <button
                    onClick={() => handleDeleteSession(sessionDetail.id)}
                    className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 font-medium"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete session
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <StatCard label="Total" value={sessionDetail.total} />
                  <StatCard label="Has WhatsApp" value={sessionDetail.withWhatsapp} color="text-green-600" />
                  <StatCard label="No WhatsApp" value={sessionDetail.withoutWhatsapp} color="text-red-500" />
                </div>
                <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">Session #{sessionDetail.id}</h3>
                    <button
                      onClick={() => handleExportCSV(sessionDetail)}
                      className="flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
                    >
                      <Download className="w-3.5 h-3.5" />
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
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-foreground">Check history</h2>
                  {history.length > 0 && (
                    <button
                      onClick={handleClearHistory}
                      className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 font-medium"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear all
                    </button>
                  )}
                </div>
                {history.length === 0 ? (
                  <div className="bg-white rounded-xl border border-border p-10 text-center text-muted-foreground text-sm shadow-sm">
                    No checks yet. Run your first check above.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {history.map((s) => (
                      <HistoryItem
                        key={s.id}
                        session={s}
                        onView={() => setViewingSession(s.id)}
                        onDelete={() => handleDeleteSession(s.id)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* STATS TAB */}
        {activeTab === "stats" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-foreground">Overall statistics</h2>
              <button
                onClick={() => refetchStats()}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
            </div>
            {stats ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <StatCard label="Total checks" value={stats.totalChecks} />
                  <StatCard label="Numbers checked" value={stats.totalNumbersChecked} />
                  <StatCard label="With WhatsApp" value={stats.totalWithWhatsapp} color="text-green-600" />
                  <StatCard label="Without WhatsApp" value={stats.totalWithoutWhatsapp} color="text-red-500" />
                </div>
                <StatCard label="WhatsApp rate" value={`${stats.successRate}%`} color="text-primary" />
                {stats.uptime !== undefined && (
                  <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Wifi className="w-4 h-4 text-green-500" />
                      <span className="text-sm font-medium text-foreground">Server uptime</span>
                    </div>
                    <span className="text-sm font-bold text-foreground">
                      {stats.uptime > 3600
                        ? `${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`
                        : `${Math.floor(stats.uptime / 60)}m`}
                    </span>
                  </div>
                )}
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

      <div className="max-w-3xl mx-auto px-4 pb-8">
        <p className="text-xs text-muted-foreground text-center">
          Use responsibly and in compliance with applicable laws.
        </p>
      </div>
    </div>
  );
}
