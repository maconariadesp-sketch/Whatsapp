import { runAgent } from "./agent/agent.ts";
import { config } from "./config.ts";
import { findOrCreateConversation, getConversation, insertMessage, updateConversation } from "./db.ts";
import { emit } from "./events.ts";
import { sendWhatsApp, type IncomingMessage } from "./whatsapp/index.ts";

// Textos enviados pelo sistema que ainda podem voltar como "eco" no webhook (Evolution API).
const recentOutgoing = new Map<string, { text: string; at: number }[]>();

function rememberOutgoing(phone: string, text: string) {
  const list = (recentOutgoing.get(phone) ?? []).filter((o) => Date.now() - o.at < 120_000);
  list.push({ text, at: Date.now() });
  recentOutgoing.set(phone, list);
}

function isEcho(phone: string, text: string) {
  const list = recentOutgoing.get(phone) ?? [];
  const i = list.findIndex((o) => o.text === text && Date.now() - o.at < 120_000);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Envia uma mensagem ao contato e registra no histórico. */
export async function deliver(conversationId: number, author: "ia" | "equipe", text: string) {
  const conv = getConversation(conversationId)!;
  let waId: string | undefined;
  if (conv.channel === "whatsapp") {
    rememberOutgoing(conv.phone, text);
    waId = await sendWhatsApp(conv.phone, text);
  }
  insertMessage(conversationId, author, text, waId);
  emit({ type: "message", conversationId });
}

// ---- Fila por conversa: espera o cliente terminar de digitar e nunca roda duas IAs ao mesmo tempo ----
const timers = new Map<number, NodeJS.Timeout>();
const running = new Set<number>();
const rerun = new Set<number>();

export function scheduleReply(conversationId: number, delayMs = config.replyDebounceMs) {
  clearTimeout(timers.get(conversationId));
  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId);
      void processConversation(conversationId);
    }, delayMs),
  );
}

async function processConversation(conversationId: number) {
  if (running.has(conversationId)) {
    rerun.add(conversationId);
    return;
  }
  running.add(conversationId);
  try {
    await runAgent(conversationId, (id, text) => deliver(id, "ia", text));
  } catch (err) {
    console.error(`[ia] erro na conversa ${conversationId}:`, err);
    insertMessage(conversationId, "sistema", `Erro ao gerar resposta automática: ${(err as Error).message}`);
    updateConversation(conversationId, { needs_attention: 1 });
    emit({ type: "message", conversationId });
  } finally {
    running.delete(conversationId);
    if (rerun.delete(conversationId)) scheduleReply(conversationId, 500);
  }
}

/** Mensagem recebida do WhatsApp (qualquer provedor). */
export function handleIncoming(msg: IncomingMessage) {
  if (msg.fromMe) {
    // Mensagem enviada pelo celular do escritório: registra como da equipe e pausa a IA.
    if (isEcho(msg.phone, msg.text)) return;
    const conv = findOrCreateConversation("whatsapp", msg.phone);
    if (!insertMessage(conv.id, "equipe", msg.text, msg.waId)) return;
    updateConversation(conv.id, { ai_enabled: 0, status: "humano" });
    emit({ type: "message", conversationId: conv.id });
    return;
  }
  const conv = findOrCreateConversation("whatsapp", msg.phone, msg.name);
  if (!insertMessage(conv.id, "cliente", msg.text, msg.waId)) return; // duplicada
  updateConversation(conv.id, {
    unread: conv.unread + 1,
    ...(conv.status === "encerrada" ? { status: "ia", ai_enabled: 1 } : {}),
  });
  emit({ type: "message", conversationId: conv.id });
  scheduleReply(conv.id);
}

/** Simulador do painel: permite testar a IA sem WhatsApp conectado. */
export function handleTestMessage(conversationId: number, text: string) {
  insertMessage(conversationId, "cliente", text);
  emit({ type: "message", conversationId });
  scheduleReply(conversationId, 1500);
}
