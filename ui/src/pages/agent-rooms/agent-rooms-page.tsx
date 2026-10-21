import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { AgentSummary } from "../../api/types.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import type { ApplicationContext } from "../../app/context-types.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";

type RoomMessage = {
  id: string;
  sender: "user" | "agent" | "system";
  agentId?: string;
  agentName?: string;
  text: string;
  createdAt: number;
};

type ChatHistory = { messages?: unknown[] };
type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

const ROOM_STORAGE_KEY = "openclaw.agent-room.v1";
const HISTORY_LIMIT = 80;
const RESPONSE_WAIT_STEPS = 24;
const RESPONSE_WAIT_MS = 500;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageText(value: unknown): string {
  const item = record(value);
  const content = item?.content ?? item?.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = record(part);
        return typeof block?.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const nested = record(content);
  return typeof nested?.text === "string" ? nested.text : "";
}

function readRoomMessages(): RoomMessage[] {
  try {
    const raw = globalThis.localStorage?.getItem(ROOM_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is RoomMessage => {
      const item = record(value);
      return (
        typeof item?.id === "string" &&
        (item.sender === "user" || item.sender === "agent" || item.sender === "system") &&
        typeof item.text === "string" &&
        typeof item.createdAt === "number"
      );
    });
  } catch {
    return [];
  }
}

function saveRoomMessages(messages: readonly RoomMessage[]) {
  try {
    globalThis.localStorage?.setItem(ROOM_STORAGE_KEY, JSON.stringify(messages.slice(-200)));
  } catch {
    // Local storage is optional; Gateway sessions remain authoritative.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export function AgentRoomsPage() {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const agentsProjection = projectAgents(context.agents);
  const [messages, setMessages] = createSignal<RoomMessage[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = createSignal<string[]>([]);
  const [draft, setDraft] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const agents = createMemo(() =>
    (agentsProjection.read().agentsList?.agents ?? []).filter((agent) => agent.kind !== "system"),
  );
  const client = createMemo(() => {
    const snapshot = gateway.read().snapshot;
    return snapshot.phase === "connected" ? snapshot.client : null;
  });

  onSettled(() => {
    setMessages(readRoomMessages());
    void context.agents
      .ensureList()
      .then((roster) => {
        const available = (roster?.agents ?? []).filter((agent) => agent.kind !== "system");
        setSelectedAgentIds((current) => {
          const retained = current.filter((id) => available.some((agent) => agent.id === id));
          return retained.length > 0 ? retained : available.map((agent) => agent.id);
        });
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  });

  const appendMessage = (message: RoomMessage) => {
    setMessages((current) => {
      const next = [...current, message];
      saveRoomMessages(next);
      return next;
    });
  };

  // Keep room turns separate from each agent's normal `main` conversation.
  const sessionKey = (agentId: string) =>
    `agent:${agentId}:room:agent-room`;

  const readHistory = (gatewayClient: GatewayClient, key: string) =>
    gatewayClient.request<ChatHistory>("chat.history", { sessionKey: key, limit: HISTORY_LIMIT });

  const askAgent = async (gatewayClient: GatewayClient, agent: AgentSummary, prompt: string) => {
    const key = sessionKey(agent.id);
    const before = await readHistory(gatewayClient, key).catch(() => ({ messages: [] }));
    const beforeCount = before.messages?.length ?? 0;
    await gatewayClient.request("chat.send", {
      sessionKey: key,
      message: prompt,
      deliver: false,
      idempotencyKey: `agent-room-${Date.now()}-${agent.id}`,
    });
    for (let step = 0; step < RESPONSE_WAIT_STEPS; step += 1) {
      await wait(RESPONSE_WAIT_MS);
      const history = await readHistory(gatewayClient, key);
      const candidate = (history.messages ?? [])
        .slice(Math.min(beforeCount, history.messages?.length ?? 0))
        .reverse()
        .find((entry) => record(entry)?.role === "assistant" && messageText(entry).trim());
      if (candidate) return messageText(candidate).trim();
    }
    throw new Error(`${agent.name ?? agent.id} did not reply within 12 seconds.`);
  };

  const toggleAgent = (agentId: string) =>
    setSelectedAgentIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );

  const send = async () => {
    const text = draft().trim();
    const gatewayClient = client();
    const selected = agents().filter((agent) => selectedAgentIds().includes(agent.id));
    if (!text || !gatewayClient || selected.length === 0 || sending()) return;
    setDraft("");
    setError(null);
    setSending(true);
    appendMessage({ id: `user-${Date.now()}`, sender: "user", text, createdAt: Date.now() });
    const prompt = `You are participating in an OpenClaw Agent Room with ${selected.map((agent) => agent.name ?? agent.id).join(", ")}. Reply independently and do not delegate unless explicitly asked.\n\nUser message:\n${text}`;
    await Promise.all(
      selected.map(async (agent) => {
        try {
          const response = await askAgent(gatewayClient, agent, prompt);
          appendMessage({
            id: `${agent.id}-${Date.now()}`,
            sender: "agent",
            agentId: agent.id,
            agentName: agent.name ?? agent.id,
            text: response,
            createdAt: Date.now(),
          });
        } catch (reason) {
          appendMessage({
            id: `${agent.id}-error-${Date.now()}`,
            sender: "system",
            agentId: agent.id,
            agentName: agent.name ?? agent.id,
            text: reason instanceof Error ? reason.message : String(reason),
            createdAt: Date.now(),
          });
        }
      }),
    );
    setSending(false);
  };

  return (
    <openclaw-agent-rooms-page>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <h1 class="page-title">{t("tabs.agentRooms")}</h1>
            <div class="page-subtitle">{t("subtitles.agentRooms")}</div>
          </div>
        </section>
      </ShellLayoutBoundary>
      <div class="agent-room-page">
        <aside class="agent-room-sidebar">
          <div class="agent-room-sidebar__heading"><div><span class="eyebrow">OpenClaw</span><h2>Shared room</h2></div><span class="agent-room-count">{selectedAgentIds().length}</span></div>
          <p class="agent-room-sidebar__hint">Choose who receives the next message. New configured agents appear automatically.</p>
          <div class="agent-room-agents">
            <Show when={!loading()} fallback={<div class="agent-room-empty">Loading agents…</div>}>
              <For each={agents()}>{(agent) => {
                const selected = () => selectedAgentIds().includes(agent.id);
                return <label class={`agent-room-agent ${selected() ? "agent-room-agent--selected" : ""}`}>
                  <input type="checkbox" checked={selected()} onChange={() => toggleAgent(agent.id)} />
                  <span class="agent-room-agent__avatar">{agent.identity?.emoji ?? "✦"}</span>
                  <span class="agent-room-agent__copy"><strong>{agent.name ?? agent.identity?.name ?? agent.id}</strong><small>{agent.model?.primary ?? "Gateway default"} · {agent.thinkingDefault ?? "Gateway default"}</small></span>
                </label>;
              }}</For>
            </Show>
          </div>
          <div class="agent-room-policy"><strong>Gateway defaults</strong><span>Model and thinking settings remain controlled by OpenClaw configuration.</span></div>
          <Show when={error()}><div class="agent-room-error">{error()}</div></Show>
        </aside>
        <main class="agent-room-main">
          <header class="agent-room-main__header"><div><span class="eyebrow">Conversation</span><h1>Agent room</h1></div><span class={`agent-room-status ${sending() ? "agent-room-status--working" : ""}`}>{sending() ? "Agents working…" : "Ready"}</span></header>
          <section class="agent-room-transcript" aria-live="polite">
            <Show when={messages().length > 0} fallback={<div class="agent-room-welcome"><span class="agent-room-welcome__mark">✦</span><h2>Start a shared conversation</h2><p>Ask selected agents for independent views, then compare their answers in one transcript.</p></div>}>
              <For each={messages()}>{(message) => <article class={`agent-room-message agent-room-message--${message.sender}`}><div class="agent-room-message__meta"><span class="agent-room-message__sender">{message.sender === "user" ? "You" : message.agentName ?? "Agent"}</span><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div><div class="agent-room-message__body">{message.text}</div></article>}</For>
            </Show>
          </section>
          <form class="agent-room-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <textarea value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Message the room…" disabled={sending() || selectedAgentIds().length === 0} rows="2" />
            <div class="agent-room-composer__footer"><span>Shift + Enter for a new line</span><button class="primary" type="submit" disabled={sending() || !draft().trim() || selectedAgentIds().length === 0}>{sending() ? "Working…" : "Send"}</button></div>
          </form>
        </main>
      </div>
    </openclaw-agent-rooms-page>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-rooms-page": HTMLAttributes<HTMLElement>;
    }
  }
}
