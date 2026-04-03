import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { checkNumbers, getHistory, getStats, getSession, getStatus, type CheckSession, type NumberResult, type ConnectionState } from "@/lib/api";
import { cn } from "@/lib/utils";

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
        {result.error && (
          <span className="text-xs text-amber-700">{result.error}</span>
        )}
      </div>
      <div className={cn(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold",
        result.error
          ? "bg-amber-100 text-amber-700"
          : result.hasWhatsapp
          ? "bg-green-100 text-green-700"
          : "bg-red-100 text-red-700"
      )}>
        {result.error ? (
          <><span>⚠</span> Unknown</>
        ) : result.hasWhatsapp ? (
          <><span>✓</span> Has WhatsApp</>
        ) : (
          <><span>✗</span> No WhatsApp</>
        )}
      </div>
    </div>
  );
}

function HistoryItem({ session, onView }: { session: CheckSession; onView: () => void }) {
  const rate = session.total > 0
    ? Math.round((session.withWhatsapp / session.total) * 100)
    : 0;
  return (
    <button
      onClick={onView}
      className="w-full text-left bg-white rounded-lg border border-border p-3 hover:border-primary/50 hover:shadow-sm transition-all"
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{session.total} numbers checked</span>
          <span className="text-xs text-muted-foreground">
            {new Date(session.checkedAt).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
            {session.withWhatsapp} ✓
          </span>
          <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
            {session.withoutWhatsapp} ✗
          </span>
          <span className="text-muted-foreground">{rate}%</span>
        </div>
      </div>
    </button>
  );
}

function ConnectionBanner({ state, qr }: { state: ConnectionState; qr: string | null }) {
  if (state === "connected") return null;

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-4">
      {state === "qr" && qr ? (
        <div className="p-6 flex flex-col items-center gap-4">
          <div className="text-center">
            <h2 className="font-bold text-foreground text-lg">Connect Your WhatsApp</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              Open WhatsApp on your phone → tap <strong>Linked Devices</strong> → scan this QR code
            </p>
          </div>
          <div className="border-4 border-primary/20 rounded-2xl p-2 bg-white shadow-inner">
            <img src={qr} alt="WhatsApp QR code" className="w-56 h-56" />
          </div>
          <p className="text-xs text-muted-foreground">QR code refreshes automatically if it expires</p>
        </div>
      ) : (
        <div className="p-5 flex items-center gap-4">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
          <div>
            <p className="text-sm font-semibold text-foreground">
              {state === "connecting" || state === "disconnected" ? "Connecting to WhatsApp…" : "WhatsApp logged out — reconnecting…"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              A QR code will appear shortly. You only need to scan it once.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function CheckerPage() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<CheckSession | null>(null);
  const [activeTab, setActiveTab] = useState<"check" | "history" | "stats">("check");
  const [viewingSession, setViewingSession] = useState<number | null>(null);

  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: (query) => {
      const conn = query.state.data?.connection;
      if (conn === "connected") return 10000;
      return 2000;
    },
  });

  const connectionState: ConnectionState = status?.connection ?? "connecting";
  const qrCode = status?.qr ?? null;

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
        queryClient.invalidateQueries({ queryKey: ["status"] });
        toast.error("WhatsApp not connected — scan the QR code first");
      } else {
        toast.error(err.message || "Check failed");
      }
    },
  });

  function handleCheck() {
    const lines = input
      .split(/[\n,;]+/)
      .map((l) => l.trim())
      .filter(Boolean);
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
          <div className={cn(
            "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full",
            connectionState === "connected"
              ? "bg-green-100 text-green-700"
              : connectionState === "qr"
              ? "bg-amber-100 text-amber-700"
              : "bg-gray-100 text-gray-500"
          )}>
            <span className={cn(
              "w-1.5 h-1.5 rounded-full",
              connectionState === "connected" ? "bg-green-500" :
              connectionState === "qr" ? "bg-amber-500" : "bg-gray-400"
            )} />
            {connectionState === "connected" ? "Connected" : connectionState === "qr" ? "Scan QR" : "Connecting…"}
          </div>
        </div>
        {/* Tabs */}
        <div className="max-w-3xl mx-auto px-4 flex gap-0 border-t border-border">
          {(["check", "history", "stats"] as const).map((tab) => (
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
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-0">
        {/* Connection banner — always visible if not connected */}
        <ConnectionBanner state={connectionState} qr={qrCode} />

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
                    <button
                      onClick={() => handleExportCSV(results)}
                      className="text-xs text-primary hover:underline font-medium"
                    >
                      Export CSV
                    </button>
                  </div>
                  <div className="space-y-2">
                    {results.results?.map((r, i) => (
                      <ResultRow key={i} result={r} />
                    ))}
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
                <button
                  onClick={() => setViewingSession(null)}
                  className="text-sm text-primary hover:underline font-medium"
                >
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
                    <button
                      onClick={() => handleExportCSV(sessionDetail)}
                      className="text-xs text-primary hover:underline font-medium"
                    >
                      Export CSV
                    </button>
                  </div>
                  <div className="space-y-2">
                    {sessionDetail.results?.map((r, i) => (
                      <ResultRow key={i} result={r} />
                    ))}
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
                    {history.map((s) => (
                      <HistoryItem key={s.id} session={s} onView={() => setViewingSession(s.id)} />
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
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-xs text-muted-foreground text-center">
          Checks numbers directly via your linked WhatsApp account. Use responsibly and in compliance with applicable laws.
        </p>
      </div>
    </div>
  );
}
