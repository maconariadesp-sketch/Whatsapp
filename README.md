# Atendimento jurídico no WhatsApp com IA

Sistema que conecta o WhatsApp do escritório a um agente de IA (Claude) que faz a **triagem de clientes**,
**coleta os dados do caso**, **marca reuniões** e **passa a conversa para a equipe** quando necessário.
Todas as conversas ficam num **painel web** (parecido com Umbler Talk / WhatsApp Web), onde a equipe acompanha
tudo em tempo real e pode assumir qualquer atendimento.

## O que ele faz

**O agente de IA:**
- Responde no WhatsApp 24h, se apresenta como assistente virtual do escritório e avisa sobre a LGPD.
- Entende o caso com perguntas curtas e preenche a **ficha de triagem**: nome, e-mail, cidade, área do direito,
  resumo do caso, prazos/audiências, se já tem advogado, urgência e classificação.
- Consulta a agenda e **marca a reunião** (online ou presencial), respeitando horário de expediente, almoço,
  antecedência mínima e reuniões já marcadas (e o Google Agenda, se conectado).
- **Transfere para a equipe** em urgências (prazo/audiência em até 48h, prisão etc.), quando o cliente pede uma pessoa,
  quando já é cliente perguntando de processo, ou em reclamações/cobranças, e avisa a equipe no WhatsApp.
- Segue as regras de ética da OAB: não dá parecer, não promete resultado, não fala de honorários (a menos que você permita).
- Junta mensagens enviadas em sequência ("oi" / "tudo bem?" / "preciso de ajuda") antes de responder.

**O painel:**
- Lista de conversas com busca e filtros (precisam de atenção, com a IA, com a equipe, encerradas).
- Chat em tempo real. Ao escrever pelo painel, **a IA é pausada naquela conversa** e você assume.
  O botão "IA ativa" devolve a conversa para a IA.
- Ficha de triagem editável, reuniões do cliente, aba **Agenda** com próximas reuniões e horários livres.
- Aba **Configurações**: nome do escritório, advogados, áreas de atuação, expediente, duração das reuniões, política de
  honorários, dados a coletar, aviso LGPD e instruções extras para a IA — sem mexer em código.
- **Conversa de teste**: simula um cliente no próprio painel, sem WhatsApp, para você testar e ajustar a IA.
- Exportação das fichas para Excel (CSV).

## Como conectar o WhatsApp — escolha uma opção

| | **API oficial da Meta (Cloud API)** — recomendado | **Evolution API (QR Code)** |
|---|---|---|
| Como funciona | Número registrado na plataforma oficial da Meta | Lê o QR Code como o WhatsApp Web |
| Risco de banimento | Nenhum (é o canal oficial, o mesmo que Umbler usa) | Existe: é uma via não oficial |
| Usar o número no celular ao mesmo tempo | Não (o número passa a ser da API)\* | Sim — e o que você responder pelo celular aparece no painel e pausa a IA |
| Custo | Conversas iniciadas pelo cliente são gratuitas na janela de 24h; mensagens iniciadas pela empresa são cobradas pela Meta | Gratuito (precisa de um servidor) |
| Burocracia | Conta Meta Business verificada | Nenhuma |

\* A Meta oferece a "coexistência" para números do app WhatsApp Business em alguns casos; verifique no painel da Meta.

Para um escritório de advocacia, a **API oficial é a escolha mais segura** (sem risco de perder o número).

## Instalação

Requisitos: um servidor (VPS) com Docker, ou qualquer máquina com Node.js 20+, e um domínio com HTTPS
(o WhatsApp só envia webhooks para endereços `https://`). Opções simples: uma VPS (Hostinger, DigitalOcean, Contabo)
com Caddy/Nginx, ou serviços como Railway/Render.

1. Copie o arquivo de configuração e preencha:
   ```bash
   cp .env.example .env
   ```
   - `ADMIN_PASSWORD`: senha do painel.
   - `ANTHROPIC_API_KEY`: chave da API do Claude (https://platform.claude.com).
   - `NOTIFY_WHATSAPP_NUMBER`: seu celular (ex.: `5511999998888`) para receber avisos.

2. Suba o sistema:
   ```bash
   docker compose up -d            # ou: npm install && npm start
   ```
   Acesse `https://SEU-DOMINIO` (ou `http://localhost:3000`), entre com a senha, vá em **Configurações**
   e preencha os dados do escritório. Use **+ Conversa de teste** para conversar com a IA como se fosse um cliente.

3. Conecte o WhatsApp:

   **Opção A — API oficial da Meta**
   1. Em https://developers.facebook.com crie um app do tipo *Business* e adicione o produto **WhatsApp**.
   2. Cadastre e verifique o número do escritório; anote o **Phone number ID** e gere um **token permanente**
      (Usuário do sistema no Business Manager com permissão `whatsapp_business_messaging`).
   3. Em *WhatsApp > Configuração*, cadastre o webhook:
      - URL: `https://SEU-DOMINIO/webhook/whatsapp`
      - Token de verificação: o mesmo valor de `META_VERIFY_TOKEN`
      - Assine o campo **messages**.
   4. No `.env`: `WHATSAPP_PROVIDER=cloud`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN`
      e `META_APP_SECRET` (Configurações do app > Básico > Chave secreta). Reinicie.

   **Opção B — Evolution API (QR Code)**
   1. No `.env`: `WHATSAPP_PROVIDER=evolution`, `EVOLUTION_API_KEY` (invente uma senha forte),
      `EVOLUTION_INSTANCE=escritorio` e `EVOLUTION_WEBHOOK_TOKEN` (outra senha).
   2. Suba com `docker compose --profile evolution up -d`.
   3. Crie a instância e leia o QR Code com o celular do escritório (manual: https://doc.evolution-api.com).
      Configure o webhook da instância para `http://app:3000/webhook/evolution?token=SEU_EVOLUTION_WEBHOOK_TOKEN`
      com o evento `MESSAGES_UPSERT`.

4. (Opcional) **Google Agenda**: crie uma conta de serviço no Google Cloud, ative a *Google Calendar API*, compartilhe a
   agenda do escritório com o e-mail da conta de serviço ("Fazer alterações nos eventos") e preencha `GOOGLE_*` no `.env`.
   A IA passa a evitar horários ocupados no Google Agenda e cria o evento da reunião lá.

## Custos da IA

Cada resposta é cobrada por tokens pela Anthropic. O sistema usa cache de prompt para baratear conversas longas.
O modelo padrão é o `claude-opus-5-5` (mais capaz). Para reduzir o custo, use `ANTHROPIC_MODEL=claude-sonnet-5-5`
e/ou `ANTHROPIC_EFFORT=low` — teste antes com conversas de teste para ver se a qualidade continua boa.
O consumo de cada resposta aparece no log do servidor.

## Limitações atuais e próximos passos

- **Áudios, imagens e documentos**: a IA vê só um aviso ("o cliente enviou um áudio") e pede para o cliente escrever.
  Próximo passo natural: transcrição automática de áudios e leitura de PDFs/imagens enviados.
- **Remarcar/cancelar** pela IA: hoje ela transfere para a equipe; o cancelamento é feito na aba Agenda
  (o cliente não é avisado automaticamente).
- Lembrete automático da reunião (ex.: 1 dia antes) ainda não existe. Pela API oficial, mensagens enviadas fora da janela
  de 24h exigem *templates* aprovados pela Meta.
- Login do painel é por senha única do escritório (sem usuários individuais).

## Ética e LGPD

O prompt da IA segue o Código de Ética da OAB e o Provimento 205/2021 (não dá parecer, não promete resultado, não capta
clientela de forma indevida) e informa o uso dos dados conforme a LGPD. Revise os textos em **Configurações** com a
política do seu escritório. O botão "Excluir conversa e dados" atende pedidos de exclusão do titular.

## Estrutura

```
src/server.ts          rotas HTTP, webhooks e API do painel
src/inbox.ts           recebe mensagens, fila por conversa, envio, pausa quando a equipe assume
src/agent/agent.ts     loop do agente com o Claude
src/agent/prompt.ts    instruções da IA (montadas a partir das Configurações)
src/agent/tools.ts     ferramentas: salvar ficha, consultar horários, agendar, transferir para humano
src/scheduling.ts      cálculo de horários livres e agendamentos
src/google.ts          integração opcional com Google Agenda
src/whatsapp/          provedores: Cloud API (Meta) e Evolution API
public/                painel web
data/                  banco SQLite (criado automaticamente — faça backup desta pasta)
```
