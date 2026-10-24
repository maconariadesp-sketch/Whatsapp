import crypto from "node:crypto";
import { config } from "../config.ts";
import { mediaPlaceholder, type IncomingMessage } from "./index.ts";

// WhatsApp Cloud API oficial da Meta.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

export async function sendText(phone: string, text: string) {
  const { graphVersion, phoneNumberId, token } = config.cloud;
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });
  if (!res.ok) throw new Error(`Meta Cloud API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { messages?: { id: string }[] };
  return json.messages?.[0]?.id;
}

/** Confere a assinatura X-Hub-Signature-256 enviada pela Meta. */
export function verifySignature(rawBody: Buffer, signature: string | undefined) {
  if (!config.cloud.appSecret) return false; // sem META_APP_SECRET não há como confirmar a origem
  if (!signature?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", config.cloud.appSecret).update(rawBody).digest("hex");
  const given = signature.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

interface CloudWebhook {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: {
          id: string;
          from: string;
          type: string;
          text?: { body: string };
          button?: { text: string };
          interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
          image?: { caption?: string };
          video?: { caption?: string };
          document?: { caption?: string; filename?: string };
        }[];
      };
    }[];
  }[];
}

export function parseWebhook(body: CloudWebhook): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const names = new Map((value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value?.messages ?? []) {
        let text: string;
        if (m.type === "text") text = m.text?.body ?? "";
        else if (m.type === "button") text = m.button?.text ?? "";
        else if (m.type === "interactive")
          text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
        else if (m.type === "image") text = mediaPlaceholder("image", m.image?.caption);
        else if (m.type === "video") text = mediaPlaceholder("video", m.video?.caption);
        else if (m.type === "document") text = mediaPlaceholder("document", m.document?.caption, m.document?.filename);
        else text = mediaPlaceholder(m.type);
        out.push({ waId: m.id, phone: m.from, name: names.get(m.from), text, fromMe: false });
      }
    }
  }
  return out;
}
