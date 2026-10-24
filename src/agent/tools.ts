import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getConversation, parseLead, updateConversation } from "../db.ts";
import { availableSlots, bookAppointment, formatPtBr, upcomingAppointments } from "../scheduling.ts";
import { emit } from "../events.ts";
import { notifyTeam } from "../notify.ts";

const nullableString = (description: string) => ({ type: ["string", "null"], description });

export const LEAD_FIELDS = {
  nome: "Nome completo",
  email: "E-mail",
  cpf: "CPF (só se o escritório pedir)",
  cidade_uf: "Cidade/UF",
  area: "Área do direito (ex.: Trabalhista, Família, Consumidor, Previdenciário)",
  resumo_caso: "Resumo objetivo do caso, em 2 a 5 frases",
  prazo_ou_audiencia: "Se há prazo, audiência ou data importante, e quando",
  ja_tem_advogado: "Se já possui advogado(a) no caso",
  urgencia: "baixa | media | alta",
  classificacao: "qualificado | fora_da_area | sem_interesse | ja_cliente | outro",
  observacoes: "Outras informações relevantes",
} as const;

type LeadField = keyof typeof LEAD_FIELDS;

export const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "salvar_dados_cliente",
    description:
      "Registra ou atualiza a ficha de triagem do cliente no painel do escritório. Chame sempre que o cliente informar dados novos. Envie null nos campos que não mudaram.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(LEAD_FIELDS).map(([k, desc]) => [k, nullableString(desc)]),
      ),
      required: Object.keys(LEAD_FIELDS),
    },
  },
  {
    name: "consultar_horarios_disponiveis",
    description:
      "Lista horários livres para reunião com o(a) advogado(a). Retorna horários no fuso do escritório. Use antes de oferecer ou marcar qualquer horário.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        a_partir_de: {
          type: ["string", "null"],
          description: "Data inicial no formato AAAA-MM-DD (null = hoje)",
        },
        dias: { type: ["integer", "null"], description: "Quantos dias consultar a partir da data inicial (padrão 5)" },
      },
      required: ["a_partir_de", "dias"],
    },
  },
  {
    name: "agendar_reuniao",
    description:
      "Marca a reunião do cliente com o(a) advogado(a) em um horário que foi retornado por consultar_horarios_disponiveis e que o cliente confirmou.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        inicio: {
          type: "string",
          description: "Início exatamente como retornado pela consulta, ex.: 2026-10-27T14:00:00-03:00",
        },
        modalidade: { type: "string", enum: ["online", "presencial"] },
        observacoes: { type: ["string", "null"], description: "Observações para o(a) advogado(a)" },
      },
      required: ["inicio", "modalidade", "observacoes"],
    },
  },
  {
    name: "transferir_para_humano",
    description:
      "Pausa o atendimento automático e avisa a equipe do escritório para assumir a conversa. Use em urgências, quando o cliente pedir uma pessoa ou em situações que você não deve conduzir.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        motivo: { type: "string", description: "Motivo da transferência, em uma frase" },
      },
      required: ["motivo"],
    },
  },
];

const LeadInput = z.record(z.string(), z.string().nullable());
const SlotsInput = z.object({ a_partir_de: z.string().nullable(), dias: z.number().int().nullable() });
const BookInput = z.object({
  inicio: z.string(),
  modalidade: z.enum(["online", "presencial"]),
  observacoes: z.string().nullable(),
});
const HandoffInput = z.object({ motivo: z.string() });

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** Se verdadeiro, a IA deve parar de responder após este turno. */
  handedOff?: boolean;
}

export async function runTool(conversationId: number, name: string, rawInput: unknown): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "salvar_dados_cliente": {
        const input = LeadInput.parse(rawInput);
        const conv = getConversation(conversationId)!;
        const lead = parseLead(conv);
        for (const [k, v] of Object.entries(input)) {
          if (k in LEAD_FIELDS && v !== null && v.trim()) lead[k as LeadField] = v.trim();
        }
        updateConversation(conversationId, {
          lead: JSON.stringify(lead),
          ...(lead.nome && !conv.contact_name ? { contact_name: lead.nome } : {}),
        });
        emit({ type: "conversation", conversationId });
        return { content: "Ficha atualizada." };
      }

      case "consultar_horarios_disponiveis": {
        const input = SlotsInput.parse(rawInput);
        const slots = await availableSlots({
          fromDate: input.a_partir_de ?? undefined,
          days: Math.min(Math.max(input.dias ?? 5, 1), 30),
          limit: 30,
        });
        if (!slots.length) {
          return { content: "Nenhum horário livre nesse período. Tente consultar a partir de uma data posterior." };
        }
        return { content: slots.map((iso) => `${iso} (${formatPtBr(iso)})`).join("\n") };
      }

      case "agendar_reuniao": {
        const input = BookInput.parse(rawInput);
        const conv = getConversation(conversationId)!;
        const lead = parseLead(conv);
        const existing = upcomingAppointments(conversationId).filter(
          (a) => a.status === "marcada" && Date.parse(a.starts_at) > Date.now(),
        );
        if (existing.length) {
          return {
            content: `O cliente já tem reunião marcada para ${formatPtBr(existing[0].starts_at)}. Para remarcar, transfira para a equipe.`,
            isError: true,
          };
        }
        const who = lead.nome ?? conv.contact_name ?? conv.phone;
        const appt = await bookAppointment({
          conversationId,
          startsAt: input.inicio,
          mode: input.modalidade,
          title: `Reunião: ${who}${lead.area ? ` (${lead.area})` : ""}`,
          notes: [
            `Telefone: +${conv.phone}`,
            lead.email && `E-mail: ${lead.email}`,
            lead.resumo_caso && `Caso: ${lead.resumo_caso}`,
            input.observacoes,
          ]
            .filter(Boolean)
            .join("\n"),
        });
        emit({ type: "appointment" });
        emit({ type: "conversation", conversationId });
        await notifyTeam(
          `📅 Nova reunião marcada pela IA\n${who} (+${conv.phone})\n${formatPtBr(appt.starts_at)} — ${appt.mode}` +
            (lead.resumo_caso ? `\nCaso: ${lead.resumo_caso}` : ""),
        );
        return { content: `Reunião marcada: ${formatPtBr(appt.starts_at)}, ${appt.mode}.` };
      }

      case "transferir_para_humano": {
        const input = HandoffInput.parse(rawInput);
        const conv = getConversation(conversationId)!;
        updateConversation(conversationId, { status: "humano", ai_enabled: 0, needs_attention: 1 });
        emit({ type: "conversation", conversationId });
        await notifyTeam(
          `🙋 Atendimento humano solicitado\n${conv.contact_name ?? "Contato"} (+${conv.phone})\nMotivo: ${input.motivo}`,
        );
        return { content: "Conversa transferida para a equipe. Avise o cliente e encerre sua participação.", handedOff: true };
      }

      default:
        return { content: `Ferramenta desconhecida: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof z.ZodError ? "Parâmetros inválidos." : (err as Error).message;
    return { content: `Erro: ${msg}`, isError: true };
  }
}
