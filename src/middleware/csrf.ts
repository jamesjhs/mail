import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

export const CSRF_COOKIE = "csrf_token";

/**
 * Generate a new cryptographically random CSRF token and bind it to the
 * response via a non-httpOnly cookie (double-submit cookie pattern).
 * Returns the token value so it can also be returned in a JSON body.
 */
export const issueCsrfToken = (res: Response): string => {
  const token = randomBytes(32).toString("hex");
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // Must be readable by the browser's JS for double-submit
    secure: env.NODE_ENV !== "development",
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
  });
  return token;
};

/**
 * Middleware that enforces the double-submit CSRF check.
 * Validates that the X-CSRF-Token request header matches the csrf_token cookie
 * using a constant-time comparison to prevent timing attacks.
 */
export const csrfProtection = (req: Request, res: Response, next: NextFunction): void => {
  const headerToken = req.header("X-CSRF-Token");
  const cookieToken = req.cookies[CSRF_COOKIE] as string | undefined;

  if (!headerToken || !cookieToken) {
    res.status(403).json({ error: "CSRF token missing" });
    return;
  }

  try {
    const a = Buffer.from(headerToken);
    const b = Buffer.from(cookieToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: "CSRF token invalid" });
      return;
    }
  } catch {
    res.status(403).json({ error: "CSRF token invalid" });
    return;
  }

  next();
};
