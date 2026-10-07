import type { Request } from "express";

export function expectedOrigin(req: Request): string {
  return process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
}
