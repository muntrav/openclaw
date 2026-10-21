import "./agent-rooms.css";
import { consume } from "@lit/context";
import type { AgentSummary } from "../../api/types.ts";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { buildAgentMainSessionKey } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

type RoomMessage = {
  id: string;
  sender: "user" | "agent" | "system";
  agentId?: string;
  agentName?: string;
  text: string;
  createdAt: number;
};

type ChatHistory = { messages?: unknown[] };

const ROOM_STORAGE_KEY = "openclaw.agent-room.v1";
const HISTORY_LIMIT = 80;
const RESPONSE_WAIT_STEPS = 24;
const RESPONSE_WAIT_MS = 500;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const item = record(part);
        return typeof item?.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const item = record(content);
  return typeof item?.text === "string" ? item.text : "";
}

function messageRole(value: unknown): string {
  const item = record(value);
  return typeof item?.role === "string" ? item.role : "";
}

function messageText(value: unknown): string {
  const item = record(value);
  return textFromContent(item?.content ?? item?.text);
}

function readRoomMessages(): RoomMessage[] {
  try {
    const raw = globalThis.localStorage?.getItem(ROOM_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
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
    // Browser storage is optional; the active Gateway sessions remain authoritative.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

class AgentRoomsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private agents: AgentSummary[] = [];
  @state() private selectedAgentIds: string[] = [];
  @state() private messages: RoomMessage[] = [];
  @state() private draft = "";
  @state() private loading = true;
  @state() private sending = false;
  @state() private error: string | null = null;

  override firstUpdated() {
    this.messages = readRoomMessages();
    void this.loadAgents();
  }

  private get client() {
    const snapshot = this.context?.gateway.snapshot;
    return snapshot?.phase === "connected" ? snapshot.client : null;
  }

  private async loadAgents() {
    this.loading = true;
    this.error = null;
    try {
      const roster = await this.context.agents.ensureList();
      const agents = (roster?.agents ?? []).filter((agent) => agent.kind !== "system");
      this.agents = agents;
      const configured = new Set(this.selectedAgentIds);
      const selected = agents.filter((agent) => configured.has(agent.id)).map((agent) => agent.id);
      this.selectedAgentIds = selected.length > 0 ? selected : agents.map((agent) => agent.id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private sessionKey(agentId: string): string {
    return buildAgentMainSessionKey({
      agentId,
      mainKey: this.context.agents.state.agentsList?.mainKey,
    });
  }

  private appendMessage(message: RoomMessage) {
    this.messages = [...this.messages, message];
    saveRoomMessages(this.messages);
  }

  private async history(client: GatewayClient, sessionKey: string) {
    return client.request<ChatHistory>("chat.history", {
      sessionKey,
      limit: HISTORY_LIMIT,
    });
  }

  private async askAgent(
    client: GatewayClient,
    agent: AgentSummary,
    message: string,
  ): Promise<string> {
    const sessionKey = this.sessionKey(agent.id);
    const before = await this.history(client, sessionKey).catch(() => ({ messages: [] }));
    const beforeCount = before.messages?.length ?? 0;
    await client.request("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: `agent-room-${Date.now()}-${agent.id}`,
    });
    for (let step = 0; step < RESPONSE_WAIT_STEPS; step += 1) {
      await wait(RESPONSE_WAIT_MS);
      const result = await this.history(client, sessionKey);
      const messages = result.messages ?? [];
      const candidate = messages
        .slice(Math.min(beforeCount, messages.length))
        .reverse()
        .find((entry) => messageRole(entry) === "assistant" && messageText(entry).trim());
      const text = candidate ? messageText(candidate).trim() : "";
      if (text) {
        return text;
      }
    }
    throw new Error(`${agent.name ?? agent.id} did not reply within 12 seconds.`);
  }

  private toggleAgent(agentId: string) {
    this.selectedAgentIds = this.selectedAgentIds.includes(agentId)
      ? this.selectedAgentIds.filter((id) => id !== agentId)
      : [...this.selectedAgentIds, agentId];
  }

  private async send() {
    const text = this.draft.trim();
    const client = this.client;
    const selected = this.agents.filter((agent) => this.selectedAgentIds.includes(agent.id));
    if (!text || !client || selected.length === 0 || this.sending) {
      return;
    }
    this.draft = "";
    this.error = null;
    this.sending = true;
    this.appendMessage({
      id: `user-${Date.now()}`,
      sender: "user",
      text,
      createdAt: Date.now(),
    });
    const prompt = `You are participating in an OpenClaw Agent Room with other agents. Reply as ${selected.map((agent) => agent.name ?? agent.id).join(", ")} are collaborating. Do not delegate to other agents unless explicitly asked.\n\nUser message:\n${text}`;
    await Promise.all(
      selected.map(async (agent) => {
        try {
          const response = await this.askAgent(client, agent, prompt);
          this.appendMessage({
            id: `${agent.id}-${Date.now()}`,
            sender: "agent",
            agentId: agent.id,
            agentName: agent.name ?? agent.id,
            text: response,
            createdAt: Date.now(),
          });
        } catch (error) {
          this.appendMessage({
            id: `${agent.id}-error-${Date.now()}`,
            sender: "system",
            agentId: agent.id,
            agentName: agent.name ?? agent.id,
            text: error instanceof Error ? error.message : String(error),
            createdAt: Date.now(),
          });
        }
      }),
    );
    this.sending = false;
  }

  private renderAgent(agent: AgentSummary) {
    const selected = this.selectedAgentIds.includes(agent.id);
    const label = agent.name ?? agent.identity?.name ?? agent.id;
    const model = agent.model?.primary ?? "Gateway default";
    const thinking = agent.thinkingDefault ?? "Gateway default";
    return html`
      <label class="agent-room-agent ${selected ? "agent-room-agent--selected" : ""}">
        <input
          type="checkbox"
          .checked=${selected}
          @change=${() => this.toggleAgent(agent.id)}
        />
        <span class="agent-room-agent__avatar">${agent.identity?.emoji ?? "✦"}</span>
        <span class="agent-room-agent__copy">
          <strong>${label}</strong>
          <small>${model} · ${thinking}</small>
        </span>
      </label>
    `;
  }

  private renderMessage(message: RoomMessage) {
    const label = message.sender === "user" ? "You" : (message.agentName ?? "Agent");
    return html`
      <article class="agent-room-message agent-room-message--${message.sender}">
        <div class="agent-room-message__meta">
          <span class="agent-room-message__sender">${label}</span>
          <time>${new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
        </div>
        <div class="agent-room-message__body">${message.text}</div>
      </article>
    `;
  }

  override render() {
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("agent-rooms")}</div>
          <div class="page-subtitle">${subtitleForRoute("agent-rooms")}</div>
        </div>
      </section>
      <div class="agent-room-page">
        <aside class="agent-room-sidebar">
          <div class="agent-room-sidebar__heading">
            <div>
              <span class="eyebrow">OpenClaw</span>
              <h2>Shared room</h2>
            </div>
            <span class="agent-room-count">${this.selectedAgentIds.length}</span>
          </div>
          <p class="agent-room-sidebar__hint">Choose who receives the next message. New configured agents appear automatically.</p>
          <div class="agent-room-agents">
            ${this.loading ? html`<div class="agent-room-empty">Loading agents…</div>` : this.agents.map((agent) => this.renderAgent(agent))}
          </div>
          <div class="agent-room-policy">
            <strong>Gateway defaults</strong>
            <span>Model and thinking settings remain controlled by OpenClaw configuration.</span>
          </div>
          ${this.error ? html`<div class="agent-room-error">${this.error}</div>` : ""}
        </aside>
        <main class="agent-room-main">
          <header class="agent-room-main__header">
            <div>
              <span class="eyebrow">Conversation</span>
              <h1>Kira + Nemo room</h1>
            </div>
            <span class="agent-room-status ${this.sending ? "agent-room-status--working" : ""}">
              ${this.sending ? "Agents working…" : "Ready"}
            </span>
          </header>
          <section class="agent-room-transcript" aria-live="polite">
            ${this.messages.length === 0
              ? html`<div class="agent-room-welcome"><span class="agent-room-welcome__mark">✦</span><h2>Start a shared conversation</h2><p>Ask selected agents for independent views, then compare their answers in one transcript.</p></div>`
              : this.messages.map((message) => this.renderMessage(message))}
          </section>
          <form class="agent-room-composer" @submit=${(event: SubmitEvent) => { event.preventDefault(); void this.send(); }}>
            <textarea
              .value=${this.draft}
              @input=${(event: Event) => { this.draft = (event.target as HTMLTextAreaElement).value; }}
              @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void this.send(); } }}
              placeholder="Message the room…"
              ?disabled=${this.sending || this.selectedAgentIds.length === 0}
              rows="2"
            ></textarea>
            <div class="agent-room-composer__footer">
              <span>Shift + Enter for a new line</span>
              <button class="primary" type="submit" ?disabled=${this.sending || !this.draft.trim() || this.selectedAgentIds.length === 0}>${this.sending ? "Working…" : "Send"}</button>
            </div>
          </form>
        </main>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-agent-rooms-page")) {
  customElements.define("openclaw-agent-rooms-page", AgentRoomsPage);
}
