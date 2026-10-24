import { db } from "./db.ts";

// Configurações editáveis pelo painel (aba "Configurações").
export interface OfficeSettings {
  officeName: string;
  assistantName: string;
  lawyers: string;
  practiceAreas: string;
  address: string;
  // Dias úteis de atendimento (0 = domingo ... 6 = sábado)
  workDays: number[];
  workStart: string; // "09:00"
  workEnd: string; // "18:00"
  lunchStart: string;
  lunchEnd: string;
  meetingMinutes: number;
  minNoticeHours: number;
  bookingWindowDays: number;
  meetingModes: string; // "online e presencial"
  consultationFeeInfo: string;
  requiredFields: string;
  privacyNotice: string;
  extraInstructions: string;
  aiGloballyEnabled: boolean;
}

export const defaultSettings: OfficeSettings = {
  officeName: "Escritório de Advocacia",
  assistantName: "Assistente Virtual",
  lawyers: "",
  practiceAreas: "Direito Civil, Direito do Consumidor, Direito de Família, Direito do Trabalho, Direito Previdenciário",
  address: "",
  workDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  lunchStart: "12:00",
  lunchEnd: "13:30",
  meetingMinutes: 60,
  minNoticeHours: 4,
  bookingWindowDays: 14,
  meetingModes: "online (videochamada) ou presencial no escritório",
  consultationFeeInfo:
    "Não informe valores de honorários. Explique que valores são tratados diretamente com o(a) advogado(a) na reunião.",
  requiredFields:
    "nome completo, e-mail, cidade/UF, área do problema, resumo do caso, se há prazo ou audiência marcada, se já possui advogado",
  privacyNotice:
    "Os dados informados são usados apenas para análise do seu caso pelo escritório, conforme a LGPD.",
  extraInstructions: "",
  aiGloballyEnabled: true,
};

export function getSettings(): OfficeSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...defaultSettings, ...stored };
}

export function saveSettings(patch: Partial<OfficeSettings>) {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (key in defaultSettings) stmt.run(key, JSON.stringify(value));
    }
  });
  tx();
  return getSettings();
}
