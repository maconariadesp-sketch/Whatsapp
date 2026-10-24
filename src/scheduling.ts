import { config } from "./config.ts";
import { db, type Appointment } from "./db.ts";
import { googleBusy, googleCreateEvent, googleDeleteEvent } from "./google.ts";
import { getSettings } from "./settings.ts";

// Todos os horários circulam como ISO 8601 com o fuso do escritório, ex.: 2026-10-27T14:00:00-03:00
const offsetMinutes = (() => {
  const m = config.utcOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return -180;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
})();

const pad = (n: number) => String(n).padStart(2, "0");

/** Converte um instante em ISO no fuso do escritório. */
export function toLocalIso(ms: number) {
  const d = new Date(ms + offsetMinutes * 60_000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${config.utcOffset}`
  );
}

/** Data/hora legível em português, ex.: "terça-feira, 27/10/2026 às 14:00". */
export function formatPtBr(iso: string) {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("pt-BR", { weekday: "long", timeZone: config.timezone });
  const date = d.toLocaleDateString("pt-BR", { timeZone: config.timezone });
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: config.timezone });
  return `${weekday}, ${date} às ${time}`;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

function busyIntervals(fromIso: string, toIso: string) {
  const rows = db
    .prepare("SELECT starts_at, ends_at FROM appointments WHERE status = 'marcada' AND ends_at > ? AND starts_at < ?")
    .all(fromIso, toIso) as { starts_at: string; ends_at: string }[];
  return rows.map((r) => [Date.parse(r.starts_at), Date.parse(r.ends_at)] as const);
}

export async function availableSlots(opts: { fromDate?: string; days?: number; limit?: number } = {}) {
  const s = getSettings();
  const now = Date.now();
  const earliest = now + s.minNoticeHours * 3_600_000;

  // Meia-noite local do dia inicial
  const todayLocal = toLocalIso(now).slice(0, 10);
  const startDay = opts.fromDate && opts.fromDate > todayLocal ? opts.fromDate : todayLocal;
  const startMs = Date.parse(`${startDay}T00:00:00${config.utcOffset}`);
  const lastAllowed = Date.parse(`${todayLocal}T00:00:00${config.utcOffset}`) + (s.bookingWindowDays + 1) * 86_400_000;
  const endMs = Math.min(startMs + (opts.days ?? 5) * 86_400_000, lastAllowed);
  if (endMs <= startMs) return [];

  const busy = [...busyIntervals(toLocalIso(startMs), toLocalIso(endMs))];
  try {
    for (const b of await googleBusy(new Date(startMs).toISOString(), new Date(endMs).toISOString())) {
      busy.push([Date.parse(b.start), Date.parse(b.end)]);
    }
  } catch (err) {
    console.error("[agenda] não foi possível consultar o Google Agenda:", err);
  }

  const slots: string[] = [];
  const dur = s.meetingMinutes;
  for (let day = startMs; day < endMs; day += 86_400_000) {
    const weekday = new Date(day + offsetMinutes * 60_000).getUTCDay();
    if (!s.workDays.includes(weekday)) continue;
    for (let m = toMinutes(s.workStart); m + dur <= toMinutes(s.workEnd); m += dur) {
      if (s.lunchStart && s.lunchEnd && overlaps(m, m + dur, toMinutes(s.lunchStart), toMinutes(s.lunchEnd))) continue;
      const slotStart = day + m * 60_000;
      const slotEnd = slotStart + dur * 60_000;
      if (slotStart < earliest) continue;
      if (busy.some(([bs, be]) => overlaps(slotStart, slotEnd, bs, be))) continue;
      slots.push(toLocalIso(slotStart));
      if (opts.limit && slots.length >= opts.limit) return slots;
    }
  }
  return slots;
}

export async function bookAppointment(input: {
  conversationId: number | null;
  startsAt: string;
  mode: "online" | "presencial";
  title: string;
  notes?: string;
}) {
  const s = getSettings();
  const start = Date.parse(input.startsAt);
  if (Number.isNaN(start)) throw new Error("Data/hora inválida.");
  const startIso = toLocalIso(start);
  const day = startIso.slice(0, 10);
  const free = await availableSlots({ fromDate: day, days: 1 });
  if (!free.includes(startIso)) {
    throw new Error("Este horário não está disponível. Consulte os horários livres novamente.");
  }
  const endIso = toLocalIso(start + s.meetingMinutes * 60_000);

  let googleEventId: string | undefined;
  try {
    googleEventId = await googleCreateEvent({
      start: startIso,
      end: endIso,
      summary: input.title,
      description: `${input.notes ?? ""}\nModalidade: ${input.mode}`.trim(),
    });
  } catch (err) {
    console.error("[agenda] falha ao criar evento no Google Agenda:", err);
  }

  const info = db
    .prepare(
      `INSERT INTO appointments (conversation_id, starts_at, ends_at, mode, title, notes, google_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.conversationId, startIso, endIso, input.mode, input.title, input.notes ?? null, googleEventId ?? null);
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(info.lastInsertRowid) as Appointment;
}

export async function cancelAppointment(id: number) {
  const appt = db.prepare("SELECT * FROM appointments WHERE id = ?").get(id) as Appointment | undefined;
  if (!appt || appt.status === "cancelada") return appt;
  db.prepare("UPDATE appointments SET status = 'cancelada' WHERE id = ?").run(id);
  if (appt.google_event_id) {
    await googleDeleteEvent(appt.google_event_id).catch((err) =>
      console.error("[agenda] falha ao remover evento do Google Agenda:", err),
    );
  }
  return { ...appt, status: "cancelada" as const };
}

export function upcomingAppointments(conversationId?: number) {
  const nowIso = toLocalIso(Date.now() - 86_400_000);
  if (conversationId) {
    return db
      .prepare("SELECT * FROM appointments WHERE conversation_id = ? ORDER BY starts_at")
      .all(conversationId) as Appointment[];
  }
  return db
    .prepare(
      `SELECT a.*, c.contact_name, c.phone FROM appointments a
       LEFT JOIN conversations c ON c.id = a.conversation_id
       WHERE a.ends_at >= ? ORDER BY a.starts_at`,
    )
    .all(nowIso) as (Appointment & { contact_name: string | null; phone: string | null })[];
}
