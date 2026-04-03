import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  checkNumbers,
  connectWhatsApp,
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
  connecting,
}: {
  state: ConnectionState;
  qr: string | null;
  onConnect: () => void;
  connecting: boolean;
}) {
  if (state === "connected") {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-3 mb-4 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
        <span className="text-sm font-semibold text-green-800">WhatsApp Connected</span>
        <span className="text-xs text-green-600">— realtime updates active</span>
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
            <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5 mt-2 inline-block">
              One-time scan — your session stays active permanently
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
              <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-gray-400 text-lg">●</div>
            )}
            <div>
              <p className="text-sm font-semibold text-foreground">
                {state === "connecting" ? "Connecting to WhatsApp…"
                  : state === "logged_out" ? "Session expired — reconnecting…"
                  : "WhatsApp not connected"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {state === "disconnected"
                  ? "Click Connect to link your WhatsApp account once."
                  : "A QR code will appear shortly. You only need to scan it once."}
              </p>
            </div>
          </div>
          {state === "disconnected" && (
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
  method,
  path,
  badge,
  description,
  children,
}: {
  method: string;
  path: string;
  badge?: string;
  description: string;
  children: React.ReactNode;
}) {
  const methodColor =
    method === "POST" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700";
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

      {/* Overview */}
      <div className="bg-white rounded-xl border border-border p-5 shadow-sm">
        <h2 className="font-bold text-lg text-foreground">WhatsApp Number Checker API</h2>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
          REST API for checking whether phone numbers are registered on WhatsApp.
          Requires a <strong>one-time QR scan</strong> to link your account — after that the session stays
          active automatically, even across server restarts.
          Base URL: <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">/api</code>
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded">One-time login</span>
          <span className="bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded">No API key</span>
          <span className="bg-purple-50 text-purple-700 border border-purple-200 px-2 py-0.5 rounded">SSE realtime</span>
          <span className="bg-orange-50 text-orange-700 border border-orange-200 px-2 py-0.5 rounded">Up to 100 numbers/request</span>
        </div>
      </div>

      {/* Quick start */}
      <div className="bg-white rounded-xl border border-border p-5 shadow-sm space-y-3">
        <h3 className="font-semibold text-foreground">Quick Start</h3>
        <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside leading-relaxed">
          <li>Check <code className="bg-gray-100 px-1 rounded text-xs font-mono">GET /api/status</code> — if <code className="bg-gray-100 px-1 rounded text-xs font-mono">connection</code> is <code className="bg-gray-100 px-1 rounded text-xs font-mono">"qr"</code>, display the QR image and scan it with your phone.</li>
          <li>Wait until <code className="bg-gray-100 px-1 rounded text-xs font-mono">connection</code> becomes <code className="bg-gray-100 px-1 rounded text-xs font-mono">"connected"</code>. Use <code className="bg-gray-100 px-1 rounded text-xs font-mono">GET /api/events</code> (SSE) for instant notification.</li>
          <li>Call <code className="bg-gray-100 px-1 rounded text-xs font-mono">POST /api/check</code> with your list of numbers.</li>
          <li>Read <code className="bg-gray-100 px-1 rounded text-xs font-mono">results[].hasWhatsapp</code> in the response.</li>
        </ol>
        <Label>Full workflow (JavaScript)</Label>
        <CodeBlock code={`// 1. Wait for connection
const es = new EventSource('/api/events');
await new Promise(resolve => {
  es.addEventListener('status', function handler(e) {
    if (JSON.parse(e.data).connection === 'connected') {
      es.removeEventListener('status', handler);
      resolve();
    }
  });
});

// 2. Check numbers
const res = await fetch('/api/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    numbers: ['+12025551234', '+447700900123', '+4915112345678']
  })
});
const session = await res.json();

// 3. Read results
session.results.forEach(r => {
  console.log(r.formattedNumber, r.hasWhatsapp ? '✓ has WhatsApp' : '✗ no WhatsApp');
});`} />
      </div>

      {/* GET /api/check/:number — single check */}
      <DocSection
        method="GET"
        path="/api/check/:number"
        badge="Single check"
        description="Check one phone number directly in the URL. Great for quick lookups, browser testing, or simple integrations. Include the country code (with or without the leading +)."
      >
        <div>
          <Label>URL parameter</Label>
          <SchemaTable rows={[
            { field: ":number", type: "string", note: "Phone number in E.164 format, e.g. +13124464775 or 13124464775. URL-encode the + as %2B if needed." },
          ]} />
        </div>
        <div>
          <Label>Response schema</Label>
          <SchemaTable rows={[
            { field: "number", type: "string", note: "The original value from the URL." },
            { field: "formattedNumber", type: "string", note: "Normalized E.164 form used for the lookup." },
            { field: "hasWhatsapp", type: "boolean", note: "true if the number is registered on WhatsApp." },
            { field: "error", type: "string | null", note: "null on success. An error message if the lookup failed." },
          ]} />
        </div>
        <div>
          <Label>Success response (200)</Label>
          <CodeBlock code={`{
  "number": "+13124464775",
  "formattedNumber": "+13124464775",
  "hasWhatsapp": true,
  "error": null
}`} />
        </div>
        <div className="space-y-2">
          <Label>Error responses</Label>
          <ErrorRow status={400} condition="number too short or malformed" body={`{ "number": "abc", "formattedNumber": "abc", "hasWhatsapp": false, "error": "Invalid number format" }`} />
          <ErrorRow status={503} condition="WhatsApp not connected" body={`{ "error": "WhatsApp not connected. Please scan the QR code first.", "connection": "qr" }`} />
        </div>
        <div className="space-y-3">
          <Label>Code examples</Label>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Browser / cURL</p>
            <CodeBlock code={`curl "https://your-domain/api/check/%2B13124464775"

# Or without encoding the +
curl "https://your-domain/api/check/13124464775"`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">JavaScript</p>
            <CodeBlock code={`const number = '+13124464775';
const res = await fetch('/api/check/' + encodeURIComponent(number));
const { formattedNumber, hasWhatsapp } = await res.json();
console.log(formattedNumber, hasWhatsapp ? '✓ has WhatsApp' : '✗ no WhatsApp');`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Python</p>
            <CodeBlock code={`import requests
from urllib.parse import quote

number = '+13124464775'
r = requests.get(f'https://your-domain/api/check/{quote(number)}')
data = r.json()
print(data['formattedNumber'], '✓' if data['hasWhatsapp'] else '✗')`} />
          </div>
        </div>
      </DocSection>

      {/* POST /api/check — batch */}
      <DocSection
        method="POST"
        path="/api/check"
        badge="Batch (up to 100)"
        description="Check multiple phone numbers in one request. The server must be in 'connected' state. Include country code in every number. Up to 100 numbers per call. Results are saved to the database."
      >
        <div>
          <Label>Request body</Label>
          <SchemaTable rows={[
            { field: "numbers", type: "string[]", note: "Phone numbers in E.164 format or digits only. Country code required. Max 100." },
          ]} />
        </div>
        <div>
          <Label>Request example</Label>
          <CodeBlock code={`POST /api/check
Content-Type: application/json

{
  "numbers": ["+12025551234", "+447700900123", "+4915112345678", "5511987654321"]
}`} />
        </div>
        <div>
          <Label>Response schema</Label>
          <SchemaTable rows={[
            { field: "id", type: "number", note: "Auto-incrementing session ID." },
            { field: "total", type: "number", note: "How many numbers were checked." },
            { field: "withWhatsapp", type: "number", note: "Count that have WhatsApp." },
            { field: "withoutWhatsapp", type: "number", note: "Count that do not have WhatsApp." },
            { field: "checkedAt", type: "string", note: "ISO 8601 timestamp of when the check ran." },
            { field: "results", type: "NumberResult[]", note: "One entry per number — see table below." },
          ]} />
        </div>
        <div>
          <Label>NumberResult schema</Label>
          <SchemaTable rows={[
            { field: "number", type: "string", note: "The original value you submitted." },
            { field: "formattedNumber", type: "string", note: "Normalized E.164 form used for the lookup, e.g. +12025551234." },
            { field: "hasWhatsapp", type: "boolean", note: "true if the number is registered on WhatsApp." },
            { field: "error", type: "string | null", note: "null on success. A message if the number was invalid or a lookup error occurred." },
          ]} />
        </div>
        <div>
          <Label>Success response (200)</Label>
          <CodeBlock code={`{
  "id": 3,
  "total": 4,
  "withWhatsapp": 3,
  "withoutWhatsapp": 1,
  "checkedAt": "2025-06-10T14:22:05.123Z",
  "results": [
    { "number": "+12025551234",   "formattedNumber": "+12025551234",   "hasWhatsapp": true,  "error": null },
    { "number": "+447700900123",  "formattedNumber": "+447700900123",  "hasWhatsapp": true,  "error": null },
    { "number": "+4915112345678", "formattedNumber": "+4915112345678", "hasWhatsapp": false, "error": null },
    { "number": "bad-number",     "formattedNumber": "bad-number",     "hasWhatsapp": false, "error": "Invalid number format" }
  ]
}`} />
        </div>
        <div className="space-y-2">
          <Label>Error responses</Label>
          <ErrorRow status={400} condition="numbers field missing or not an array" body={`{ "error": "numbers must be a non-empty array" }`} />
          <ErrorRow status={400} condition="more than 100 numbers submitted" body={`{ "error": "Maximum 100 numbers per request" }`} />
          <ErrorRow status={503} condition="WhatsApp not yet connected" body={`{
  "error": "WhatsApp not connected. Please scan the QR code first.",
  "connection": "qr",
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}`} />
        </div>
        <div className="space-y-3">
          <Label>Code examples</Label>
          <div>
            <p className="text-xs text-muted-foreground mb-1">cURL</p>
            <CodeBlock code={`curl -X POST https://your-domain/api/check \\
  -H "Content-Type: application/json" \\
  -d '{"numbers":["+12025551234","+447700900123"]}'`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">JavaScript</p>
            <CodeBlock code={`const res = await fetch('/api/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ numbers: ['+12025551234', '+447700900123'] })
});

if (!res.ok) {
  const { error } = await res.json();
  throw new Error(error); // e.g. "WhatsApp not connected"
}

const { id, total, withWhatsapp, results } = await res.json();
console.log(\`Session \${id}: \${withWhatsapp}/\${total} have WhatsApp\`);

results.forEach(r => {
  const icon = r.error ? '⚠' : r.hasWhatsapp ? '✓' : '✗';
  console.log(icon, r.formattedNumber);
});`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Python</p>
            <CodeBlock code={`import requests

r = requests.post('https://your-domain/api/check',
    json={'numbers': ['+12025551234', '+447700900123', '+4915112345678']})

if r.status_code != 200:
    print('Error:', r.json()['error'])
else:
    data = r.json()
    print(f"Session {data['id']}: {data['withWhatsapp']}/{data['total']} have WhatsApp")
    for result in data['results']:
        icon = '⚠' if result['error'] else ('✓' if result['hasWhatsapp'] else '✗')
        print(f"  {icon} {result['formattedNumber']}")`} />
          </div>
        </div>
      </DocSection>

      {/* GET /api/status */}
      <DocSection
        method="GET"
        path="/api/status"
        description="Return the current WhatsApp connection state and, when a QR scan is needed, the QR code image as a base64 data URL."
      >
        <div>
          <Label>Response schema</Label>
          <SchemaTable rows={[
            { field: "connection", type: "string", note: "connecting | qr | connected | logged_out" },
            { field: "qr", type: "string | null", note: "Base64 PNG data URL. Only present when connection === 'qr'." },
          ]} />
        </div>
        <div className="space-y-2">
          <Label>Response examples</Label>
          <div>
            <p className="text-xs text-muted-foreground mb-1">When connected</p>
            <CodeBlock code={`{ "connection": "connected", "qr": null }`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">When QR scan is needed</p>
            <CodeBlock code={`{
  "connection": "qr",
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}`} />
          </div>
        </div>
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl https://your-domain/api/status`} />
        </div>
      </DocSection>

      {/* GET /api/events */}
      <DocSection
        method="GET"
        path="/api/events"
        description="Server-Sent Events stream. Pushes a 'status' event in real time whenever the connection state or QR code changes — no polling needed. The current state is sent immediately on connect."
      >
        <div>
          <Label>Event format</Label>
          <CodeBlock code={`event: status\ndata: { "connection": "connected", "qr": null }`} />
        </div>
        <div>
          <Label>JavaScript (EventSource)</Label>
          <CodeBlock code={`const es = new EventSource('/api/events');

es.addEventListener('status', (e) => {
  const { connection, qr } = JSON.parse(e.data);

  if (connection === 'qr' && qr) {
    document.getElementById('qr-img').src = qr; // Show QR to user
  }
  if (connection === 'connected') {
    console.log('Ready to check numbers!');
  }
});

// Stop listening when done
// es.close();`} />
        </div>
        <div>
          <Label>Python (sseclient-rs)</Label>
          <CodeBlock code={`import sseclient, requests, json

res = requests.get('https://your-domain/api/events', stream=True)
for event in sseclient.SSEClient(res).events():
    if event.event == 'status':
        data = json.loads(event.data)
        print(data['connection'])  # e.g. "connected"
        if data['connection'] == 'connected':
            break  # Ready to check numbers`} />
        </div>
      </DocSection>

      {/* GET /api/history */}
      <DocSection
        method="GET"
        path="/api/history"
        description="List all past check sessions, newest first. Returns summaries — no per-number results. Use GET /api/history/:id to get full results for a specific session."
      >
        <div>
          <Label>Response (array of session summaries)</Label>
          <CodeBlock code={`[
  { "id": 4, "total": 20, "withWhatsapp": 15, "withoutWhatsapp": 5, "checkedAt": "2025-06-10T15:00:00.000Z" },
  { "id": 3, "total": 4,  "withWhatsapp": 3,  "withoutWhatsapp": 1, "checkedAt": "2025-06-10T14:22:05.123Z" }
]`} />
        </div>
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl https://your-domain/api/history`} />
        </div>
      </DocSection>

      {/* GET /api/history/:id */}
      <DocSection
        method="GET"
        path="/api/history/:id"
        description="Get the full result of a specific session including every number's result. Use the id from GET /api/history."
      >
        <div>
          <Label>Response</Label>
          <CodeBlock code={`{
  "id": 3,
  "total": 4,
  "withWhatsapp": 3,
  "withoutWhatsapp": 1,
  "checkedAt": "2025-06-10T14:22:05.123Z",
  "results": [
    { "number": "+12025551234",   "formattedNumber": "+12025551234",   "hasWhatsapp": true,  "error": null },
    { "number": "+447700900123",  "formattedNumber": "+447700900123",  "hasWhatsapp": true,  "error": null },
    { "number": "+4915112345678", "formattedNumber": "+4915112345678", "hasWhatsapp": false, "error": null },
    { "number": "bad-number",     "formattedNumber": "bad-number",     "hasWhatsapp": false, "error": "Invalid number format" }
  ]
}`} />
        </div>
        <div className="space-y-2">
          <Label>Error responses</Label>
          <ErrorRow status={404} condition="session ID does not exist" body={`{ "error": "Session not found" }`} />
        </div>
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl https://your-domain/api/history/3`} />
        </div>
      </DocSection>

      {/* GET /api/stats */}
      <DocSection
        method="GET"
        path="/api/stats"
        description="Cumulative totals and WhatsApp rate across all sessions run on this server."
      >
        <div>
          <Label>Response</Label>
          <CodeBlock code={`{
  "totalChecks": 12,
  "totalNumbersChecked": 847,
  "totalWithWhatsapp": 631,
  "totalWithoutWhatsapp": 216,
  "successRate": 74.5
}`} />
        </div>
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl https://your-domain/api/stats`} />
        </div>
      </DocSection>

      {/* GET /api/healthz */}
      <DocSection
        method="GET"
        path="/api/healthz"
        description="Lightweight health check. Returns 200 OK with current connection state."
      >
        <div>
          <Label>Response</Label>
          <CodeBlock code={`{ "status": "ok", "connection": "connected" }`} />
        </div>
        <div>
          <Label>cURL</Label>
          <CodeBlock code={`curl https://your-domain/api/healthz`} />
        </div>
      </DocSection>

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
  const [connectPending, setConnectPending] = useState(false);

  const queryClient = useQueryClient();

  // Bootstrap with HTTP fetch, then switch to SSE for realtime updates.
  // A polling fallback runs every 8s while not connected, so the QR always
  // appears even if the SSE connection is dropped or buffered by a proxy.
  useEffect(() => {
    let sseCleanup: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function applyStatus(s: WAStatus) {
      setConnectionState(s.connection);
      setQrCode(s.qr);
    }

    async function poll() {
      try { applyStatus(await getStatus()); } catch (_) {}
    }

    poll().finally(() => {
      sseCleanup = createStatusEventSource(applyStatus);
      // Polling fallback: keeps the QR fresh even when SSE is unreliable
      pollTimer = setInterval(poll, 8000);
    });

    return () => {
      sseCleanup?.();
      if (pollTimer) clearInterval(pollTimer);
    };
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
            connecting={connectPending || connectionState === "connecting"}
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
