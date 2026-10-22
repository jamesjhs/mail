// Keep credentials and signed download links out of persisted diagnostics.
export const redactDiagnostic = (value: string) => value
  .replace(/\b(?:re_|whsec_)[A-Za-z0-9_+/=-]+/g, "[redacted]")
  .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
  .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[redacted]")
  .slice(0, 2000);

export const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return "Unknown error";
  const details = error as Error & { code?: string; responseCode?: number; cause?: { code?: string } };
  const codes = [details.code, details.responseCode, details.cause?.code].filter(Boolean).join(", ");
  return redactDiagnostic(`${error.message}${codes ? ` (${codes})` : ""}`);
};

export const apiFailure = async (response: Response, stage: string) => {
  let detail = "";
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
      detail = `: ${body.message}`;
    }
  } catch { /* A non-JSON error response still has a useful HTTP status. */ }
  return new Error(redactDiagnostic(`${stage} failed with status ${response.status}${detail}`));
};
