import { config } from "../config.ts";
import { mediaPlaceholder, type IncomingMessage } from "./index.ts";

// Evolution API (conexão por QR Code, usando o WhatsApp do próprio celular).
// Docs: https://doc.evolution-api.com

export async function sendText(phone: string, text: string) {
  const { url, apiKey, instance } = config.evolution;
  const res = await fetch(`${url}/message/sendText/${encodeURIComponent(instance)}`, {
    method: "POST",
    headers: { apikey: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ number: phone, text }),
  });
  if (!res.ok) throw new Error(`Evolution API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { key?: { id?: string } };
  return json.key?.id;
}

interface EvolutionMessage {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean };
  pushName?: string;
  messageType?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string; fileName?: string };
    documentWithCaptionMessage?: { message?: { documentMessage?: { caption?: string; fileName?: string } } };
    buttonsResponseMessage?: { selectedDisplayText?: string };
    listResponseMessage?: { title?: string };
  };
}

export function parseWebhook(body: { event?: string; data?: EvolutionMessage | EvolutionMessage[] }) {
  const event = (body.event ?? "").toLowerCase().replace(/_/g, ".");
  if (event !== "messages.upsert") return [];
  const items = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
  const out: IncomingMessage[] = [];
  for (const d of items) {
    const jid = d.key?.remoteJid ?? "";
    // Ignora grupos, status e canais: só conversas individuais
    if (!jid.endsWith("@s.whatsapp.net") || !d.key?.id) continue;
    const m = d.message ?? {};
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage;
    let text = m.conversation ?? m.extendedTextMessage?.text ?? m.buttonsResponseMessage?.selectedDisplayText ??
      m.listResponseMessage?.title;
    if (text === undefined) {
      if (m.imageMessage) text = mediaPlaceholder("image", m.imageMessage.caption);
      else if (m.videoMessage) text = mediaPlaceholder("video", m.videoMessage.caption);
      else if (doc) text = mediaPlaceholder("document", doc.caption, doc.fileName);
      else {
        const kind = (d.messageType ?? "desconhecido").replace(/Message$/, "");
        text = mediaPlaceholder(kind === "audio" ? "audio" : kind);
      }
    }
    out.push({
      waId: d.key.id,
      phone: jid.split("@")[0],
      name: d.key.fromMe ? undefined : d.pushName,
      text,
      fromMe: Boolean(d.key.fromMe),
    });
  }
  return out;
}
