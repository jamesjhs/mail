export type DeliveryStatus = "PENDING" | "FAILED" | "BOUNCED";

export interface Rule {
  id: number;
  name: string;
  pattern: string;
  endpointUrl: string;
  patternType: "wildcard" | "regex";
  enabled: number;
  createdAt: string;
}

export interface PendingMessage {
  id: string;
  status: DeliveryStatus;
  attempts: number;
  destination: string | null;
  lastAttempt: string;
  receivedAt: string;
}
