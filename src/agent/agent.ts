import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { getConversation, insertMessage, messagesAfter, updateConversation } from "../db.ts";
import { emit } from "../events.ts";
import { formatPtBr, toLocalIso } from "../scheduling.ts";
import { getSettings } from "../settings.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { runTool, tools } from "./tools.ts";

const client = new Anthropic();
const MAX_STEPS = 8;

/** Envia uma resposta ao cliente (definida em inbox.ts, que conhece o canal). */
export type Sender = (conversationId: number, text: string) => Promise<void>;

/**
 * Processa as mensagens novas de uma conversa e responde.
 * O histórico enviado ao Claude é só de acréscimo (nunca editado), como a API exige
 * para manter os blocos de raciocínio válidos entre turnos.
 */
export async function runAgent(conversationId: number, send: Sender) {
  const conv = getConversation(conversationId);
  if (!conv || !conv.ai_enabled || conv.status === "encerrada") return;
  const settings = getSettings();
  if (!settings.aiGloballyEnabled) return;

  const pending = messagesAfter(conv.id, conv.ai_cursor).filter((m) => m.author === "cliente" || m.author === "equipe");
  if (!pending.some((m) => m.author === "cliente")) return;
  const cursor = pending[pending.length - 1].id;

  const lines = pending.map((m) =>
    m.author === "equipe" ? `[Mensagem enviada pela equipe do escritório]: ${m.body}` : m.body,
  );
  const history: Anthropic.Beta.BetaMessageParam[] = JSON.parse(conv.ai_history);
  history.push({
    role: "user",
    content: `[Data/hora atual: ${formatPtBr(toLocalIso(Date.now()))}]\n${lines.join("\n")}`,
  });

  const system = buildSystemPrompt(settings);

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      system,
      tools,
      messages: history,
      output_config: { effort: config.anthropicEffort },
      cache_control: { type: "ephemeral" },
      // Se o modelo recusar algo por segurança, a API tenta de novo em outro modelo automaticamente.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    console.log(
      `[ia] conversa ${conv.id}: stop=${response.stop_reason} in=${response.usage.input_tokens} ` +
        `cache=${response.usage.cache_read_input_tokens ?? 0} out=${response.usage.output_tokens}`,
    );

    if (response.stop_reason === "refusal") {
      // Não registra o turno recusado; passa para a equipe.
      updateConversation(conv.id, { status: "humano", ai_enabled: 0, needs_attention: 1, ai_cursor: cursor });
      insertMessage(conv.id, "sistema", "A IA não pôde responder a esta mensagem. Conversa passada para a equipe.");
      emit({ type: "conversation", conversationId: conv.id });
      return;
    }

    history.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    // Salva antes de enviar: se o envio falhar, o histórico continua consistente.
    updateConversation(conv.id, { ai_history: JSON.stringify(history), ai_cursor: cursor });
    if (text) {
      for (const part of text.split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean)) {
        await send(conv.id, part);
      }
    }

    if (response.stop_reason !== "tool_use") return;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const outcome = await runTool(conv.id, call.name, call.input);
      console.log(`[ia] ferramenta ${call.name} -> ${outcome.content.slice(0, 120)}`);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    history.push({ role: "user", content: results });
    updateConversation(conv.id, { ai_history: JSON.stringify(history) });
  }
  console.warn(`[ia] conversa ${conv.id}: limite de passos atingido`);
}
