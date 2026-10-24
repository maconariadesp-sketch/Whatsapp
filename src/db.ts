import Database from "better-sqlite3";
import path from "node:path";
import { config } from "./config.ts";

export const db = new Database(path.join(config.dataDir, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',      -- whatsapp | teste
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'ia',             -- ia | humano | encerrada
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  lead TEXT NOT NULL DEFAULT '{}',
  ai_history TEXT NOT NULL DEFAULT '[]',         -- histórico no formato da API do Claude (somente acréscimo)
  ai_cursor INTEGER NOT NULL DEFAULT 0,          -- última mensagem já entregue à IA
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel, phone)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author TEXT NOT NULL,                          -- cliente | ia | equipe | sistema
  body TEXT NOT NULL,
  wa_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  starts_at TEXT NOT NULL,                       -- ISO 8601 com fuso
  ends_at TEXT NOT NULL,
  mode TEXT NOT NULL,                            -- online | presencial
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'marcada',        -- marcada | cancelada
  google_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export type Author = "cliente" | "ia" | "equipe" | "sistema";

export interface Conversation {
  id: number;
  phone: string;
  channel: "whatsapp" | "teste";
  contact_name: string | null;
  status: "ia" | "humano" | "encerrada";
  ai_enabled: number;
  needs_attention: number;
  unread: number;
  lead: string;
  ai_history: string;
  ai_cursor: number;
  last_message_at: string | null;
  created_at: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  author: Author;
  body: string;
  wa_id: string | null;
  created_at: string;
}

export interface Appointment {
  id: number;
  conversation_id: number | null;
  starts_at: string;
  ends_at: string;
  mode: "online" | "presencial";
  title: string;
  notes: string | null;
  status: "marcada" | "cancelada";
  google_event_id: string | null;
  created_at: string;
}

export function getConversation(id: number) {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Conversation | undefined;
}

export function findOrCreateConversation(channel: Conversation["channel"], phone: string, name?: string) {
  const existing = db
    .prepare("SELECT * FROM conversations WHERE channel = ? AND phone = ?")
    .get(channel, phone) as Conversation | undefined;
  if (existing) {
    if (name && !existing.contact_name) {
      db.prepare("UPDATE conversations SET contact_name = ? WHERE id = ?").run(name, existing.id);
    }
    return getConversation(existing.id)!;
  }
  const info = db
    .prepare("INSERT INTO conversations (channel, phone, contact_name) VALUES (?, ?, ?)")
    .run(channel, phone, name ?? null);
  return getConversation(Number(info.lastInsertRowid))!;
}

export function updateConversation(id: number, fields: Partial<Omit<Conversation, "id">>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE conversations SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({
    ...fields,
    id,
  });
}

export function insertMessage(conversationId: number, author: Author, body: string, waId?: string) {
  const info = db
    .prepare("INSERT OR IGNORE INTO messages (conversation_id, author, body, wa_id) VALUES (?, ?, ?, ?)")
    .run(conversationId, author, body, waId ?? null);
  if (!info.changes) return undefined; // mensagem duplicada (webhook reenviado)
  db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(conversationId);
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid) as Message;
}

export function messagesAfter(conversationId: number, afterId: number) {
  return db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id")
    .all(conversationId, afterId) as Message[];
}

export function parseLead(conv: Conversation): Record<string, string> {
  try {
    return JSON.parse(conv.lead);
  } catch {
    return {};
  }
}
