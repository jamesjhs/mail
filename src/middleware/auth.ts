import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { verifySessionToken } from "../services/auth.js";

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const token = req.cookies[env.SESSION_COOKIE_NAME];
  if (!token || !verifySessionToken(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};
