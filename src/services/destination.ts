import { z } from "zod";
import { isPrivateHostname } from "../utils/net.js";

export const destinationSchema = z.string().refine((value) => {
  if (value.startsWith("mailto:")) return z.string().email().safeParse(value.slice(7)).success;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !isPrivateHostname(value);
  } catch {
    return false;
  }
}, { message: "Enter a public HTTP(S) endpoint or mailto: followed by one email address" });
