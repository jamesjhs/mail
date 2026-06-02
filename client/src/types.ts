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
  messageId: string;
  destination: string | null;
  status: string;
  eventTime: string;
}

export interface PendingItem {
  id: string;
  status: string;
  attempts: number;
  destination: string | null;
  last_attempt: string;
  received_at: string;
}
