import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Carrega um arquivo .env simples (CHAVE=valor) sem dependências externas.
function loadDotEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const env = (key: string, fallback = "") => process.env[key] ?? fallback;

export type WhatsAppProvider = "cloud" | "evolution" | "none";

export const config = {
  port: Number(env("PORT", "3000")),
  dataDir: path.resolve(env("DATA_DIR", "./data")),

  // Painel
  adminPassword: env("ADMIN_PASSWORD"),

  // Claude
  anthropicModel: env("ANTHROPIC_MODEL", "claude-opus-5-5"),
  anthropicEffort: env("ANTHROPIC_EFFORT", "medium") as "low" | "medium" | "high",

  // Agrupa mensagens enviadas em sequência pelo cliente antes de responder
  replyDebounceMs: Number(env("REPLY_DEBOUNCE_SECONDS", "8")) * 1000,

  // Fuso horário do escritório (Brasília não tem horário de verão desde 2019)
  timezone: env("TIMEZONE", "America/Sao_Paulo"),
  utcOffset: env("UTC_OFFSET", "-03:00"),

  // WhatsApp
  provider: env("WHATSAPP_PROVIDER", "none") as WhatsAppProvider,
  cloud: {
    token: env("META_ACCESS_TOKEN"),
    phoneNumberId: env("META_PHONE_NUMBER_ID"),
    verifyToken: env("META_VERIFY_TOKEN"),
    appSecret: env("META_APP_SECRET"),
    graphVersion: env("META_GRAPH_VERSION", "v21.0"),
  },
  evolution: {
    url: env("EVOLUTION_API_URL").replace(/\/$/, ""),
    apiKey: env("EVOLUTION_API_KEY"),
    instance: env("EVOLUTION_INSTANCE"),
    webhookToken: env("EVOLUTION_WEBHOOK_TOKEN"),
  },

  // Número (com DDI) que recebe avisos de reuniões marcadas / pedidos de atendimento humano
  notifyNumber: env("NOTIFY_WHATSAPP_NUMBER").replace(/\D/g, ""),

  // Google Agenda (opcional) — conta de serviço com acesso à agenda do escritório
  google: {
    calendarId: env("GOOGLE_CALENDAR_ID"),
    serviceAccountEmail: env("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    privateKey: env("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
  },
};

export const googleEnabled = Boolean(
  config.google.calendarId && config.google.serviceAccountEmail && config.google.privateKey,
);

fs.mkdirSync(config.dataDir, { recursive: true });

// Segredo que assina o cookie de login. Se não for definido no .env, é gerado e guardado em data/.
export const sessionSecret = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(config.dataDir, "session-secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
})();
