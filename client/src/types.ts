export interface Rule {
  id: number;
  name: string;
  pattern: string;
  patternType: "wildcard" | "regex";
  endpointUrl: string;
  webhookKey: string;
  enabled: number;
}

export interface AuditItem {
  id: number;
  messageId: string;
  destination: string | null;
  status: string;
  eventTime: string;
  error: string | null;
  attempt: number | null;
}

export interface PendingItem {
  id: string;
  status: string;
  attempts: number;
  destination: string | null;
  last_attempt: string;
  received_at: string;
  last_error: string | null;
}
