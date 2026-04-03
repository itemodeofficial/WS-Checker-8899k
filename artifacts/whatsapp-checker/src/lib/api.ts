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

export async function checkNumbers(numbers: string[]): Promise<CheckSession> {
  const res = await fetch(`${BASE}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ numbers }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Request failed");
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
