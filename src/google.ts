import crypto from "node:crypto";
import { config, googleEnabled } from "./config.ts";

// Integração mínima com o Google Agenda via conta de serviço (sem SDK do Google).
let cachedToken: { token: string; expiresAt: number } | undefined;

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: config.google.serviceAccountEmail,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claim}`), config.google.privateKey);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${b64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth falhou: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function calendarApi(pathname: string, init: RequestInit = {}) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Google Agenda: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export async function googleBusy(timeMin: string, timeMax: string): Promise<{ start: string; end: string }[]> {
  if (!googleEnabled) return [];
  const json = (await calendarApi("/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: config.google.calendarId }] }),
  })) as { calendars: Record<string, { busy: { start: string; end: string }[] }> };
  return json.calendars[config.google.calendarId]?.busy ?? [];
}

export async function googleCreateEvent(ev: { start: string; end: string; summary: string; description: string }) {
  if (!googleEnabled) return undefined;
  const json = (await calendarApi(`/calendars/${encodeURIComponent(config.google.calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.start, timeZone: config.timezone },
      end: { dateTime: ev.end, timeZone: config.timezone },
    }),
  })) as { id: string };
  return json.id;
}

export async function googleDeleteEvent(eventId: string) {
  if (!googleEnabled) return;
  await calendarApi(`/calendars/${encodeURIComponent(config.google.calendarId)}/events/${eventId}`, {
    method: "DELETE",
  });
}
