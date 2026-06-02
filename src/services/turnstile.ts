import { env } from "../config/env.js";

export const verifyTurnstile = async (token: string, ip?: string) => {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });

  if (ip) {
    body.set("remoteip", ip);
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    return false;
  }

  const json = (await response.json()) as { success?: boolean };
  return json.success === true;
};
