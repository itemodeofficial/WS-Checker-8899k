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
}

export type ConnectionState = "disconnected" | "qr" | "connecting" | "connected" | "logged_out";

export interface WAStatus {
  connection: ConnectionState;
  qr: string | null;
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

export async function checkNumbers(numbers: string[]): Promise<CheckSession & { connection?: ConnectionState; qr?: string | null }> {
  const res = await fetch(`${BASE}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numbers }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    const error = new Error(err.error || "Request failed") as Error & { connection?: string; qr?: string };
    error.connection = err.connection;
    error.qr = err.qr;
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

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${BASE}/stats`);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export function createStatusEventSource(onStatus: (status: WAStatus) => void): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.addEventListener("status", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      onStatus(data);
    } catch (_) {}
  });
  es.onerror = () => {
    // SSE will auto-reconnect; no action needed
  };
  return () => es.close();
}
