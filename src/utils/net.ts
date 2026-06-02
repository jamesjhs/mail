/**
 * Returns true when the URL's hostname resolves to a loopback address,
 * a link-local address, or any RFC-1918 / RFC-4193 private-network range.
 * Used to prevent server-side request forgery via admin-configured endpoint URLs.
 */
const PRIVATE_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // link-local
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/, // IPv6 loopback
  /^\[?fc[0-9a-f]{2}:/i, // IPv6 ULA (fc00::/7)
  /^\[?fd[0-9a-f]{2}:/i, // IPv6 ULA (fd00::/8)
];

export const isPrivateHostname = (urlString: string): boolean => {
  try {
    const { hostname } = new URL(urlString);
    return PRIVATE_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return true; // malformed URL — treat as unsafe
  }
};
