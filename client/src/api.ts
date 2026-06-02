import type { AuditItem, PendingItem, Rule } from "./types";

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  return (await response.text()) as T;
};

export const api = {
  getPublicConfig: () => request<{ turnstileSiteKey: string; version: string }>("/api/public/config"),
  requestAuth: (payload: { email: string; password: string; turnstileToken: string }) =>
    request<{ challengeId: string; message: string }>("/api/auth/request", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  verifyOtp: (payload: { challengeId: string; otp: string }) =>
    request<{ success: boolean }>("/api/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getMe: () => request<{ email: string; version: string }>("/api/admin/me"),
  logout: () => request<{ success: boolean }>("/api/auth/logout", { method: "POST" }),
  listRules: () => request<Rule[]>("/api/admin/rules"),
  createRule: (payload: Omit<Rule, "id" | "enabled">) =>
    request<{ success: boolean }>("/api/admin/rules", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateRule: (rule: Rule) =>
    request<{ success: boolean }>(`/api/admin/rules/${rule.id}`, {
      method: "PUT",
      body: JSON.stringify(rule),
    }),
  deleteRule: (id: number) => request<{ success: boolean }>(`/api/admin/rules/${id}`, { method: "DELETE" }),
  listAudit: (page: number, pageSize = 20) =>
    request<{ total: number; items: AuditItem[] }>(`/api/admin/messages?page=${page}&pageSize=${pageSize}`),
  listPending: () => request<PendingItem[]>("/api/admin/pending"),
  retryPending: (id: string) => request<{ success: boolean }>(`/api/admin/pending/${id}/retry`, { method: "POST" }),
  bouncePending: (id: string) => request<{ success: boolean }>(`/api/admin/pending/${id}/bounce`, { method: "POST" }),
  getSettings: () => request<Array<{ key: string; value: string }>>("/api/admin/settings"),
  setWebhookSecret: (value: string) =>
    request<{ success: boolean }>("/api/admin/settings/webhook-signing-secret", {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  getHelp: () => request<string>("/api/admin/help"),
  resetPassword: (payload: { token: string; password: string }) =>
    request<{ success: boolean }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
