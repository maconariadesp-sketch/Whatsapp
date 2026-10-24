import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, sessionSecret } from "./config.ts";

// Login simples por senha única do escritório, com cookie assinado (HMAC) válido por 7 dias.
const COOKIE = "painel_sessao";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const sign = (payload: string) => crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");

export function checkPassword(password: string) {
  if (!config.adminPassword) return false;
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(config.adminPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

export function setSessionCookie(res: Response) {
  const payload = String(Date.now() + MAX_AGE_MS);
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_MS,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE);
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isAuthenticated(req: Request) {
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(payload) > Date.now();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: "Não autenticado" });
}
