const BASE = "/api";

export interface NumberResult {
  number: string;
  formattedNumber: string;
  hasWhatsapp: boolean;
  error: string | null;
}

export interface CheckSession {
  id: number;
  total: number;
  withWhatsapp: number;
  withoutWhatsapp: number;
  checkedAt: string;
  results?: NumberResult[];
}

export interface Stats {
  totalChecks: number;
  totalNumbersChecked: number;
  totalWithWhatsapp: number;
  totalWithoutWhatsapp: number;
  successRate: number;
  uptime?: number;
}

export type ConnectionState = "disconnected" | "qr" | "connecting" | "connected" | "logged_out";

export interface WAStatus {
  connection: ConnectionState;
  qrVersion: number;
}

export interface ProgressUpdate {
  checked: number;
  total: number;
  current?: string;
  withWA?: number;
  withoutWA?: number;
  done?: boolean;
}

export async function getStatus(): Promise<WAStatus> {
  const res = await fetch(`${BASE}/status`);
  if (!res.ok) throw new Error("Failed to fetch status");
  return res.json();
}

export async function connectWhatsApp(): Promise<{ message: string; connection: string }> {
  const res = await fetch(`${BASE}/connect`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to connect");
  return res.json();
}

export async function disconnectWhatsApp(): Promise<{ message: string; connection: string }> {
  const res = await fetch(`${BASE}/disconnect`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to disconnect");
  return res.json();
}

export async function forceQR(): Promise<{ message: string; connection: string }> {
  const res = await fetch(`${BASE}/force-qr`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to force QR");
  return res.json();
}

export async function checkNumbers(numbers: string[]): Promise<CheckSession & { connection?: ConnectionState; qrVersion?: number }> {
  const res = await fetch(`${BASE}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numbers }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    const error = new Error(err.error || "Request failed") as Error & { connection?: string; qrVersion?: number };
    error.connection = err.connection;
    error.qrVersion = err.qrVersion;
    throw error;
  }
  return res.json();
}

export async function getHistory(): Promise<CheckSession[]> {
  const res = await fetch(`${BASE}/history`);
  if (!res.ok) throw new Error("Failed to fetch history");
  return res.json();
}

export async function getSession(id: number): Promise<CheckSession> {
  const res = await fetch(`${BASE}/history/${id}`);
  if (!res.ok) throw new Error("Failed to fetch session");
  return res.json();
}

export async function deleteSession(id: number): Promise<void> {
  const res = await fetch(`${BASE}/history/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete session");
}

export async function clearHistory(): Promise<void> {
  const res = await fetch(`${BASE}/history`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to clear history");
}

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${BASE}/stats`);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export function createStatusEventSource(
  onStatus: (status: WAStatus) => void,
  onProgress?: (progress: ProgressUpdate) => void
): () => void {
  const es = new EventSource(`${BASE}/events`);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function handleStatus(status: WAStatus) {
    if (status.connection === "connected" || status.connection === "qr") {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      onStatus(status);
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onStatus(status);
    }, 1200);
  }

  es.addEventListener("status", (e: MessageEvent) => {
    try { handleStatus(JSON.parse(e.data)); } catch (_) {}
  });

  if (onProgress) {
    es.addEventListener("progress", (e: MessageEvent) => {
      try { onProgress(JSON.parse(e.data)); } catch (_) {}
    });
  }

  es.onerror = () => {};

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    es.close();
  };
}
