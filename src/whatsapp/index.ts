import { config } from "../config.ts";
import * as cloud from "./cloud.ts";
import * as evolution from "./evolution.ts";

/** Mensagem recebida, já normalizada, vinda de qualquer provedor. */
export interface IncomingMessage {
  waId: string; // id único da mensagem no WhatsApp (evita duplicidade)
  phone: string; // número do contato só com dígitos, com DDI
  name?: string;
  text: string; // texto (ou descrição de mídia)
  fromMe: boolean; // enviada pelo próprio número do escritório (ex.: pelo celular)
}

/** Envia texto pelo provedor configurado. Retorna o id da mensagem, quando houver. */
export async function sendWhatsApp(phone: string, text: string): Promise<string | undefined> {
  switch (config.provider) {
    case "cloud":
      return cloud.sendText(phone, text);
    case "evolution":
      return evolution.sendText(phone, text);
    default:
      console.log(`[whatsapp] (sem provedor configurado) -> ${phone}: ${text}`);
      return undefined;
  }
}

export function mediaPlaceholder(kind: string, caption?: string, filename?: string) {
  const labels: Record<string, string> = {
    audio: "um áudio",
    ptt: "um áudio",
    image: "uma imagem",
    video: "um vídeo",
    document: "um documento",
    sticker: "uma figurinha",
    location: "uma localização",
    contacts: "um contato",
  };
  const what = labels[kind] ?? `uma mensagem do tipo "${kind}"`;
  return `[O cliente enviou ${what}${filename ? ` (${filename})` : ""}${caption ? ` com a legenda: "${caption}"` : ""}]`;
}
