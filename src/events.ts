import { EventEmitter } from "node:events";

// Barramento de eventos em memória: o painel recebe atualizações em tempo real via SSE.
export type AppEvent =
  | { type: "message"; conversationId: number }
  | { type: "conversation"; conversationId: number }
  | { type: "appointment" };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export const emit = (ev: AppEvent) => bus.emit("event", ev);
export const subscribe = (fn: (ev: AppEvent) => void) => {
  bus.on("event", fn);
  return () => bus.off("event", fn);
};
