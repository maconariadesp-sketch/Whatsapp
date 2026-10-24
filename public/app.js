// Painel de atendimento — JavaScript puro, sem build.
// Todo texto vindo de clientes é inserido com textContent (nunca innerHTML).

const $ = (sel) => document.querySelector(sel);
const state = { conversations: [], currentId: null, current: null, settings: null };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "/login") {
    showLogin();
    throw new Error("Não autenticado");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

const fmtTime = (sqlDate) => {
  // datas do SQLite vêm em UTC sem fuso: "2026-10-24 21:53:00"
  const d = new Date(sqlDate.replace(" ", "T") + "Z");
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) +
        " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};
const fmtIso = (iso) =>
  new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const authorLabel = { cliente: "Cliente", ia: "IA", equipe: "Equipe", sistema: "Sistema" };
const providerLabel = { cloud: "WhatsApp oficial (Meta)", evolution: "WhatsApp (QR Code)", none: "WhatsApp não conectado" };

// ---------------- Login ----------------
function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/login", { method: "POST", body: { password: $("#password").value } });
    start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  location.reload();
});

// ---------------- Abas ----------------
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    for (const t of ["conversas", "agenda", "config"]) $(`#tab-${t}`).classList.toggle("hidden", t !== btn.dataset.tab);
    if (btn.dataset.tab === "agenda") loadAgenda();
    if (btn.dataset.tab === "config") loadSettings();
  }),
);

// ---------------- Lista de conversas ----------------
async function loadConversations() {
  const q = encodeURIComponent($("#search").value);
  state.conversations = await api(`/conversations?q=${q}&filter=${$("#filter").value}`);
  renderList();
}

function statusTags(c) {
  const tags = [];
  if (c.channel === "teste") tags.push(el("span", { class: "tag teste" }, "teste"));
  if (c.needsAttention) tags.push(el("span", { class: "tag atencao" }, "atenção"));
  if (c.status === "ia") tags.push(el("span", { class: "tag ia" }, "IA"));
  if (c.status === "humano") tags.push(el("span", { class: "tag humano" }, "equipe"));
  if (c.status === "encerrada") tags.push(el("span", { class: "tag" }, "encerrada"));
  if (c.area) tags.push(el("span", { class: "tag" }, c.area));
  if (c.urgencia === "alta") tags.push(el("span", { class: "tag alta" }, "urgente"));
  return tags;
}

function renderList() {
  const list = $("#conv-list");
  list.replaceChildren(
    ...state.conversations.map((c) =>
      el(
        "li",
        { class: c.id === state.currentId ? "active" : "", onclick: () => openConversation(c.id) },
        el(
          "div",
          { class: "conv-top" },
          el("span", { class: "conv-name" }, c.name || `+${c.phone}`),
          el("span", { class: "muted small" }, fmtTime(c.lastMessageAt)),
        ),
        el(
          "div",
          { class: "conv-top" },
          el("span", { class: "conv-last" }, c.lastMessage ? `${authorLabel[c.lastMessage.author]}: ${c.lastMessage.body}` : "—"),
          c.unread ? el("span", { class: "badge" }, String(c.unread)) : null,
        ),
        el("div", { class: "tags" }, statusTags(c)),
      ),
    ),
  );
  if (!state.conversations.length) list.append(el("li", { class: "muted" }, "Nenhuma conversa ainda."));
}

let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadConversations, 250);
});
$("#filter").addEventListener("change", loadConversations);

$("#new-test").addEventListener("click", async () => {
  const name = prompt("Nome do cliente fictício:", "Cliente de teste");
  if (name === null) return;
  const { id } = await api("/test-conversations", { method: "POST", body: { name } });
  await loadConversations();
  openConversation(id);
});

// ---------------- Conversa aberta ----------------
async function openConversation(id) {
  state.currentId = id;
  $(".conversas").classList.add("chat-open");
  await refreshConversation(true);
  api(`/conversations/${id}/read`, { method: "POST" }).catch(() => {});
  renderList();
}

async function refreshConversation(scroll = false) {
  if (!state.currentId) return;
  let c;
  try {
    c = await api(`/conversations/${state.currentId}`);
  } catch {
    closeChat();
    return;
  }
  state.current = c;
  $("#chat-empty").classList.add("hidden");
  $("#chat").classList.remove("hidden");
  $("#chat-name").textContent = c.name || `+${c.phone}`;
  $("#chat-phone").textContent = c.channel === "teste" ? "Conversa de teste (não usa WhatsApp)" : `+${c.phone}`;
  $("#ai-toggle").checked = c.aiEnabled;
  $("#test-hint").classList.toggle("hidden", c.channel !== "teste");
  $("#close-conv").textContent = c.status === "encerrada" ? "Reabrir" : "Encerrar";

  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren(
    ...c.messages.map((m) =>
      el(
        "div",
        { class: `msg ${m.author}` },
        m.body,
        el("div", { class: "meta" }, `${authorLabel[m.author]} · ${fmtTime(m.created_at)}`),
      ),
    ),
  );
  if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
  renderLead(c);
  renderConvAppointments(c);
}

function closeChat() {
  state.currentId = null;
  state.current = null;
  $("#chat").classList.add("hidden");
  $("#chat-empty").classList.remove("hidden");
  $(".conversas").classList.remove("chat-open");
}

$("#back").addEventListener("click", () => {
  closeChat();
  renderList();
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#composer-text").value.trim();
  if (!text || !state.current) return;
  $("#composer-text").value = "";
  const asClient = state.current.channel === "teste" && $("#as-client").checked;
  try {
    await api(`/conversations/${state.currentId}/${asClient ? "test-message" : "send"}`, { method: "POST", body: { text } });
  } catch (err) {
    alert(`Não foi possível enviar: ${err.message}`);
    $("#composer-text").value = text;
  }
});
$("#composer-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

$("#ai-toggle").addEventListener("change", async (e) => {
  await api(`/conversations/${state.currentId}/ai`, { method: "POST", body: { enabled: e.target.checked } });
});

$("#close-conv").addEventListener("click", async () => {
  const status = state.current.status === "encerrada" ? "ia" : "encerrada";
  await api(`/conversations/${state.currentId}/status`, { method: "POST", body: { status } });
});

$("#toggle-info").addEventListener("click", () => $("#info-pane").classList.toggle("hidden"));

$("#delete-conv").addEventListener("click", async () => {
  if (!confirm("Excluir esta conversa, a ficha e o histórico? Isso não pode ser desfeito.")) return;
  await api(`/conversations/${state.currentId}`, { method: "DELETE" });
  closeChat();
  $("#info-pane").classList.add("hidden");
  loadConversations();
});

// ---------------- Ficha de triagem ----------------
function renderLead(c) {
  const form = $("#lead-form");
  if (form.contains(document.activeElement)) return; // não atrapalha quem está digitando
  const long = new Set(["resumo_caso", "observacoes", "prazo_ou_audiencia"]);
  const labels = { area: "Área do direito", resumo_caso: "Resumo do caso", prazo_ou_audiencia: "Prazo / audiência", ja_tem_advogado: "Já tem advogado(a)?", urgencia: "Urgência (baixa / media / alta)", classificacao: "Classificação" };
  form.replaceChildren(
    ...Object.entries(c.leadFields).map(([key, label]) =>
      el(
        "label",
        {},
        labels[key] || label,
        long.has(key)
          ? el("textarea", { name: key, rows: 3 }, c.lead[key] || "")
          : el("input", { name: key, value: c.lead[key] || "" }),
      ),
    ),
    el("button", { type: "submit", class: "small" }, "Salvar ficha"),
  );
}

$("#lead-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  await api(`/conversations/${state.currentId}/lead`, { method: "PUT", body: data });
  document.activeElement.blur();
  refreshConversation();
});

function apptItem(a, withContact = false) {
  const who = withContact ? `${a.contact_name || (a.phone ? "+" + a.phone : "")} — ` : "";
  return el(
    "li",
    { class: a.status },
    el("div", {}, el("strong", {}, fmtIso(a.starts_at)), el("div", { class: "small muted" }, `${who}${a.title} · ${a.mode}`)),
    a.status === "marcada"
      ? el(
          "button",
          {
            class: "ghost small",
            onclick: async () => {
              if (!confirm("Cancelar esta reunião? (O cliente não é avisado automaticamente.)")) return;
              await api(`/appointments/${a.id}/cancel`, { method: "POST" });
              refreshConversation();
              loadAgenda();
            },
          },
          "Cancelar",
        )
      : el("span", { class: "small muted" }, "cancelada"),
  );
}

function renderConvAppointments(c) {
  const ul = $("#conv-appts");
  ul.replaceChildren(...c.appointments.map((a) => apptItem(a)));
  if (!c.appointments.length) ul.append(el("li", { class: "muted small" }, "Nenhuma reunião marcada."));
}

// ---------------- Agenda ----------------
async function loadAgenda() {
  const [appts, slots] = await Promise.all([api("/appointments"), api("/slots")]);
  const ul = $("#appt-list");
  ul.replaceChildren(...appts.map((a) => apptItem(a, true)));
  if (!appts.length) ul.append(el("li", { class: "muted" }, "Nenhuma reunião marcada."));
  $("#slot-list").replaceChildren(...slots.map((s) => el("span", { class: "slot" }, fmtIso(s))));
  if (!slots.length) $("#slot-list").append(el("span", { class: "muted" }, "Nenhum horário livre no período."));
}

// ---------------- Configurações ----------------
const settingsSchema = [
  ["officeName", "Nome do escritório"],
  ["assistantName", "Nome da assistente virtual"],
  ["lawyers", "Advogados(as)", "Ex.: Dra. Fulana (OAB/SP 123.456) — Trabalhista"],
  ["practiceAreas", "Áreas de atuação", "A IA só oferece reunião para essas áreas", "textarea"],
  ["address", "Endereço do escritório"],
  ["workDays", "Dias de atendimento", "", "days"],
  ["row", [["workStart", "Início", "", "time"], ["workEnd", "Fim", "", "time"], ["lunchStart", "Almoço (início)", "", "time"], ["lunchEnd", "Almoço (fim)", "", "time"]]],
  ["row", [["meetingMinutes", "Duração da reunião (min)", "", "number"], ["minNoticeHours", "Antecedência mínima (h)", "", "number"], ["bookingWindowDays", "Agendar até (dias à frente)", "", "number"]]],
  ["meetingModes", "Modalidades de reunião"],
  ["consultationFeeInfo", "Honorários / valor da consulta", "O que a IA pode (ou não) dizer sobre valores", "textarea"],
  ["requiredFields", "Dados a coletar na triagem", "", "textarea"],
  ["privacyNotice", "Aviso de privacidade (LGPD)", "Mencionado no primeiro contato", "textarea"],
  ["extraInstructions", "Instruções adicionais para a IA", "Ex.: perguntas específicas por área, tom de voz, avisos", "textarea"],
  ["aiGloballyEnabled", "IA ligada para todas as conversas", "Desligue para pausar todo o atendimento automático", "checkbox"],
];
const dayNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function settingField([key, label, hint, type = "text"]) {
  const v = state.settings[key];
  let input;
  if (type === "textarea") input = el("textarea", { name: key, rows: 3 }, v ?? "");
  else if (type === "checkbox") input = el("input", { type: "checkbox", name: key, checked: Boolean(v), style: "width:auto" });
  else if (type === "days")
    input = el(
      "div",
      { class: "days" },
      dayNames.map((d, i) => el("label", {}, el("input", { type: "checkbox", name: "workDays", value: String(i), checked: v.includes(i) }), d)),
    );
  else input = el("input", { type, name: key, value: v ?? "" });
  return el("label", {}, label, hint ? el("span", { class: "muted small" }, hint) : null, input);
}

async function loadSettings() {
  state.settings = await api("/settings");
  $("#settings-fields").replaceChildren(
    ...settingsSchema.map((f) => (f[0] === "row" ? el("div", { class: "row" }, f[1].map(settingField)) : settingField(f))),
  );
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const patch = {};
  for (const f of settingsSchema.flatMap((f) => (f[0] === "row" ? f[1] : [f]))) {
    const [key, , , type] = f;
    if (type === "days") patch[key] = [...form.querySelectorAll('input[name="workDays"]:checked')].map((i) => Number(i.value));
    else if (type === "checkbox") patch[key] = form.elements[key].checked;
    else if (type === "number") patch[key] = Number(form.elements[key].value);
    else patch[key] = form.elements[key].value;
  }
  state.settings = await api("/settings", { method: "PUT", body: patch });
  $("#settings-saved").textContent = "Salvo ✓";
  setTimeout(() => ($("#settings-saved").textContent = ""), 2500);
});

// ---------------- Tempo real ----------------
function connectEvents() {
  const es = new EventSource("/api/events");
  let listTimer;
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    clearTimeout(listTimer);
    listTimer = setTimeout(loadConversations, 200);
    if (ev.conversationId && ev.conversationId === state.currentId) refreshConversation();
    if (ev.type === "appointment") {
      if (!$("#tab-agenda").classList.contains("hidden")) loadAgenda();
      if (state.currentId) refreshConversation();
    }
    if (ev.type === "message" && ev.conversationId === state.currentId && !document.hidden) {
      api(`/conversations/${state.currentId}/read`, { method: "POST" }).catch(() => {});
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 3000);
  };
}

// ---------------- Início ----------------
async function start() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  const status = await api("/status");
  $("#status-pill").textContent = `${providerLabel[status.provider] || status.provider}${status.googleCalendar ? " · Google Agenda" : ""}`;
  await loadConversations();
  connectEvents();
}

api("/me").then((r) => (r.authenticated ? start() : showLogin())).catch(showLogin);
