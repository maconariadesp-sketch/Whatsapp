import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEAD_FIELDS } from "./agent/tools.ts";
import { checkPassword, clearSessionCookie, isAuthenticated, requireAuth, setSessionCookie } from "./auth.ts";
import { config, googleEnabled } from "./config.ts";
import { db, findOrCreateConversation, getConversation, parseLead, updateConversation, type Conversation } from "./db.ts";
import { emit, subscribe } from "./events.ts";
import { deliver, handleIncoming, handleTestMessage, scheduleReply } from "./inbox.ts";
import { availableSlots, bookAppointment, cancelAppointment, upcomingAppointments } from "./scheduling.ts";
import { getSettings, saveSettings } from "./settings.ts";
import * as cloud from "./whatsapp/cloud.ts";
import * as evolution from "./whatsapp/evolution.ts";

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));

app.disable("x-powered-by");
// Guarda o corpo bruto para validar a assinatura da Meta
app.use(express.json({ limit: "5mb", verify: (req, _res, buf) => ((req as Request & { rawBody?: Buffer }).rawBody = buf) }));

// ---------------- Webhooks do WhatsApp ----------------

// Meta Cloud API: verificação do webhook
app.get("/webhook/whatsapp", (req, res) => {
  const token = config.cloud.verifyToken;
  if (token && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === token) {
    res.send(String(req.query["hub.challenge"]));
  } else {
    res.sendStatus(403);
  }
});

// Meta Cloud API: mensagens recebidas
app.post("/webhook/whatsapp", (req, res) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  if (!cloud.verifySignature(raw, req.header("x-hub-signature-256"))) return res.sendStatus(401);
  res.sendStatus(200); // responde logo; a Meta reenvia se demorar
  for (const msg of cloud.parseWebhook(req.body)) handleIncoming(msg);
});

// Evolution API: configure o webhook como https://SEU-DOMINIO/webhook/evolution?token=SEU_TOKEN
app.post("/webhook/evolution", (req, res) => {
  const token = config.evolution.webhookToken;
  if (!token || req.query.token !== token) return res.sendStatus(401);
  res.sendStatus(200);
  for (const msg of evolution.parseWebhook(req.body)) handleIncoming(msg);
});

// ---------------- Login ----------------

app.post("/api/login", (req, res) => {
  if (!config.adminPassword) return res.status(500).json({ error: "Defina ADMIN_PASSWORD no arquivo .env" });
  if (!checkPassword(String(req.body?.password ?? ""))) return res.status(401).json({ error: "Senha incorreta" });
  setSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => res.json({ authenticated: isAuthenticated(req) }));

// ---------------- API do painel (exige login) ----------------

const api = express.Router();
api.use(requireAuth);

const idParam = (req: Request) => Number(req.params.id);

function conversationSummary(c: Conversation) {
  const last = db
    .prepare("SELECT author, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1")
    .get(c.id) as { author: string; body: string; created_at: string } | undefined;
  const lead = parseLead(c);
  return {
    id: c.id,
    phone: c.phone,
    channel: c.channel,
    name: c.contact_name ?? lead.nome ?? null,
    status: c.status,
    aiEnabled: Boolean(c.ai_enabled),
    needsAttention: Boolean(c.needs_attention),
    unread: c.unread,
    area: lead.area ?? null,
    urgencia: lead.urgencia ?? null,
    classificacao: lead.classificacao ?? null,
    lastMessage: last ?? null,
    lastMessageAt: c.last_message_at ?? c.created_at,
  };
}

api.get("/status", (_req, res) => {
  res.json({
    provider: config.provider,
    googleCalendar: googleEnabled,
    model: config.anthropicModel,
    notifyNumber: Boolean(config.notifyNumber),
  });
});

api.get("/conversations", (req, res) => {
  const rows = db.prepare("SELECT * FROM conversations ORDER BY COALESCE(last_message_at, created_at) DESC").all() as Conversation[];
  const q = String(req.query.q ?? "").toLowerCase().trim();
  const filter = String(req.query.filter ?? "todas");
  const list = rows.map(conversationSummary).filter((c) => {
    if (filter === "ia" && c.status !== "ia") return false;
    if (filter === "humano" && c.status !== "humano") return false;
    if (filter === "atencao" && !c.needsAttention) return false;
    if (filter === "encerrada" && c.status !== "encerrada") return false;
    if (!q) return true;
    return [c.name, c.phone, c.area, c.lastMessage?.body].some((v) => v?.toLowerCase().includes(q));
  });
  res.json(list);
});

api.get("/conversations/:id", (req, res) => {
  const conv = getConversation(idParam(req));
  if (!conv) return res.sendStatus(404);
  const messages = db
    .prepare("SELECT id, author, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id")
    .all(conv.id);
  res.json({
    ...conversationSummary(conv),
    lead: parseLead(conv),
    leadFields: LEAD_FIELDS,
    messages,
    appointments: upcomingAppointments(conv.id),
  });
});

api.post("/conversations/:id/read", (req, res) => {
  updateConversation(idParam(req), { unread: 0 });
  emit({ type: "conversation", conversationId: idParam(req) });
  res.json({ ok: true });
});

// Mensagem escrita por alguém da equipe: a IA é pausada nessa conversa.
api.post("/conversations/:id/send", async (req, res) => {
  const conv = getConversation(idParam(req));
  const text = String(req.body?.text ?? "").trim();
  if (!conv || !text) return res.sendStatus(400);
  updateConversation(conv.id, { ai_enabled: 0, status: "humano", needs_attention: 0, unread: 0 });
  try {
    await deliver(conv.id, "equipe", text);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

api.post("/conversations/:id/ai", (req, res) => {
  const conv = getConversation(idParam(req));
  if (!conv) return res.sendStatus(404);
  const enabled = Boolean(req.body?.enabled);
  updateConversation(conv.id, enabled ? { ai_enabled: 1, status: "ia", needs_attention: 0 } : { ai_enabled: 0, status: "humano" });
  emit({ type: "conversation", conversationId: conv.id });
  if (enabled) scheduleReply(conv.id, 1000); // responde mensagens que chegaram enquanto estava pausada
  res.json({ ok: true });
});

api.post("/conversations/:id/status", (req, res) => {
  const status = String(req.body?.status);
  if (!["ia", "humano", "encerrada"].includes(status)) return res.sendStatus(400);
  updateConversation(idParam(req), {
    status: status as Conversation["status"],
    ai_enabled: status === "ia" ? 1 : 0,
    needs_attention: 0,
  });
  emit({ type: "conversation", conversationId: idParam(req) });
  res.json({ ok: true });
});

api.put("/conversations/:id/lead", (req, res) => {
  const conv = getConversation(idParam(req));
  if (!conv) return res.sendStatus(404);
  const lead = Object.fromEntries(
    Object.entries(req.body ?? {}).filter(([k, v]) => k in LEAD_FIELDS && typeof v === "string" && v.trim()),
  );
  updateConversation(conv.id, { lead: JSON.stringify(lead), ...(lead.nome ? { contact_name: String(lead.nome) } : {}) });
  emit({ type: "conversation", conversationId: conv.id });
  res.json({ ok: true });
});

api.delete("/conversations/:id", (req, res) => {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(idParam(req));
  emit({ type: "conversation", conversationId: idParam(req) });
  res.json({ ok: true });
});

// Simulador
api.post("/test-conversations", (req, res) => {
  const name = String(req.body?.name ?? "").trim() || "Cliente de teste";
  const conv = findOrCreateConversation("teste", `teste-${Date.now()}`, name);
  emit({ type: "conversation", conversationId: conv.id });
  res.json({ id: conv.id });
});

api.post("/conversations/:id/test-message", (req, res) => {
  const conv = getConversation(idParam(req));
  const text = String(req.body?.text ?? "").trim();
  if (!conv || conv.channel !== "teste" || !text) return res.sendStatus(400);
  handleTestMessage(conv.id, text);
  res.json({ ok: true });
});

// Agenda
api.get("/appointments", (_req, res) => res.json(upcomingAppointments()));

api.get("/slots", async (req, res) => {
  res.json(await availableSlots({ fromDate: req.query.from ? String(req.query.from) : undefined, days: 7 }));
});

api.post("/appointments", async (req, res) => {
  try {
    const appt = await bookAppointment({
      conversationId: req.body?.conversationId ? Number(req.body.conversationId) : null,
      startsAt: String(req.body?.startsAt),
      mode: req.body?.mode === "presencial" ? "presencial" : "online",
      title: String(req.body?.title || "Reunião"),
      notes: req.body?.notes ? String(req.body.notes) : undefined,
    });
    emit({ type: "appointment" });
    res.json(appt);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

api.post("/appointments/:id/cancel", async (req, res) => {
  await cancelAppointment(idParam(req));
  emit({ type: "appointment" });
  res.json({ ok: true });
});

// Configurações do escritório
api.get("/settings", (_req, res) => res.json(getSettings()));
api.put("/settings", (req, res) => res.json(saveSettings(req.body ?? {})));

// Exporta a ficha de triagem de todos os contatos em CSV (abre no Excel)
api.get("/export.csv", (_req, res) => {
  const rows = db.prepare("SELECT * FROM conversations WHERE channel = 'whatsapp' ORDER BY created_at").all() as Conversation[];
  const cols = ["telefone", "status", "criado_em", ...Object.keys(LEAD_FIELDS)];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((c) => {
    const lead = parseLead(c);
    return [c.phone, c.status, c.created_at, ...Object.keys(LEAD_FIELDS).map((k) => lead[k])].map(esc).join(";");
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="triagem.csv"');
  res.send("﻿" + [cols.join(";"), ...lines].join("\n"));
});

// Atualizações em tempo real (Server-Sent Events)
api.get("/events", (req: Request, res: Response) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": conectado\n\n");
  const unsubscribe = subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.use("/api", api);

// Painel web
app.use(express.static(path.join(here, "..", "public")));

app.listen(config.port, () => {
  console.log(`Painel disponível em http://localhost:${config.port}`);
  console.log(`WhatsApp: ${config.provider} | Google Agenda: ${googleEnabled ? "ativo" : "desativado"} | Modelo: ${config.anthropicModel}`);
  if (!config.adminPassword) console.warn("ATENÇÃO: defina ADMIN_PASSWORD no .env para acessar o painel.");
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ATENÇÃO: defina ANTHROPIC_API_KEY no .env para a IA responder.");
});
