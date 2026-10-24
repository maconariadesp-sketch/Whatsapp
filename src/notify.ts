import { config } from "./config.ts";
import { sendWhatsApp } from "./whatsapp/index.ts";

/** Avisa a equipe no WhatsApp configurado em NOTIFY_WHATSAPP_NUMBER (se houver). */
export async function notifyTeam(text: string) {
  console.log(`[aviso] ${text.replace(/\n/g, " | ")}`);
  if (!config.notifyNumber || config.provider === "none") return;
  try {
    await sendWhatsApp(config.notifyNumber, text);
  } catch (err) {
    console.error("[aviso] falha ao notificar a equipe:", err);
  }
}
