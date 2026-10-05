import type { Person, SendMessage, ServerEvent } from "@alicia/protocol";
import { chooseModel } from "../agent/model.ts";
import { buildSystemPrompt, timestamp } from "../agent/system-prompt.ts";
import { describeAttachments } from "../attachments/prompt.ts";
import type { AttachmentStore, ClaimResult } from "../attachments/store.ts";
import type { Clock } from "../clock.ts";
import { type Engine, type EngineEvent, INCOMPLETE_TURN_MESSAGE } from "../engine/engine.ts";
import { buildSheet } from "../memory/sheet.ts";
import type { MemoryStore } from "../memory/store.ts";
import { truncate } from "../text.ts";
import { labelOf, type ToolCatalog } from "../tools/catalog.ts";
import {
  type ConfirmationOutcome, type ConfirmationRequest, type ConfirmationWhere, TOOL_RUN_BUDGET_MS,
} from "../tools/confirmations.ts";
import { createNativeGuard } from "../tools/native-guard.ts";
import { TurnContext } from "../tools/turn.ts";
import type { Conversation, ConversationRepository, LoggedToolCall, Message } from "./repository.ts";

export interface ChatDependencies {
  repository: ConversationRepository;
  engine: Engine;
  memory: MemoryStore;
  /** Tool providers; each turn builds its tools from them. */
  tools: ToolCatalog;
  /** Files sent with the messages (pending uploads, then per-conversation folders). */
  attachments: AttachmentStore;
  clock: Clock;
  timezone: string;
}

/** What a turn needs from the connection that started it. */
export interface TurnPorts {
  /** Asks the person on that device; settles "cancelled" when `signal` aborts (the turn ended). */
  confirm(where: ConfirmationWhere, request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationOutcome>;
  /** How long that device has to answer. */
  confirmationTimeoutMs: number;
}

type EngineError = Extract<EngineEvent, { type: "error" }>;

const TITLE_LENGTH = 60;
const RESUME_MESSAGE_COUNT = 10;
const RESUME_MESSAGE_CHARS = 1_000;
const RESUME_TOTAL_CHARS = 8_000;
const ATTACHMENT_GONE = "Pièce jointe introuvable ou expirée : joins-la à nouveau.";
const ATTACHMENT_FAILED = "Impossible de joindre les fichiers pour l'instant : réessaie.";
const RESUME_HEADER = "Contexte : la conversation précédente n'a pas pu être reprise. Ses derniers échanges :";

function resumeLine(m: Message): string {
  return `${m.role === "user" ? "Utilisateur" : "Alicia"} : ${truncate(m.text, RESUME_MESSAGE_CHARS)}`;
}

function toEngineError(cause: unknown): EngineError {
  return { type: "error", code: "engine", message: cause instanceof Error ? cause.message : String(cause) };
}

export function titleFrom(text: string): string {
  return truncate((text.split("\n")[0] ?? "").trim(), TITLE_LENGTH);
}

/**
 * Primes a new SDK session when the previous one is lost or unreadable (spec, « Erreurs »): the last
 * exchanges stored in the database, each cut to 1,000 characters, the most recent kept first. The context
 * (header, exchanges and line breaks) never exceeds 8,000 characters; the new message follows it, whole.
 */
export function buildResumePrompt(history: readonly Message[], prompt: string): string {
  const lines: string[] = [];
  let total = RESUME_HEADER.length;
  for (const m of [...history].reverse()) {
    const line = resumeLine(m);
    // + 1: the line break before each exchange.
    if (total + 1 + line.length > RESUME_TOTAL_CHARS) break;
    lines.unshift(line);
    total += 1 + line.length;
  }
  if (lines.length === 0) return prompt;
  return `${RESUME_HEADER}\n${lines.join("\n")}\n\nNouveau message :\n${prompt}`;
}

export async function* handleSend(
  deps: ChatDependencies,
  person: Person,
  message: SendMessage,
  signal: AbortSignal,
  ports: TurnPorts,
): AsyncGenerator<ServerEvent> {
  const start = deps.clock();

  let existing: Conversation | undefined;
  if (message.conversationId !== undefined) {
    existing = deps.repository.get(message.conversationId, person.id);
    if (existing === undefined) {
      yield {
        type: "error", requestId: message.requestId, code: "invalid_request", message: "Conversation introuvable.",
      };
      return;
    }
  }
  // Only the person's own pending uploads, checked before anything is created: a bad id (unknown, someone
  // else's, already sent, expired) must not leave an empty conversation behind.
  const pending = deps.attachments.pending(person.id, message.attachments ?? []);
  if (pending === undefined) {
    yield { type: "error", requestId: message.requestId, code: "invalid_request", message: ATTACHMENT_GONE };
    return;
  }
  const conversation =
    existing ?? deps.repository.create(person.id, titleFrom(message.text) || (pending[0]?.name ?? "Pièce jointe"));
  const conversationId = conversation.id;
  let announced = false;
  try {
    yield { type: "conversation", requestId: message.requestId, conversationId };
    announced = true;
  } finally {
    // The consumer stopped right at this first event (backpressure, connection gone): a conversation
    // created for this turn is still empty, so it is dropped rather than left in the list.
    if (!announced && message.conversationId === undefined) deps.repository.delete(conversationId, person.id);
  }

  const history = deps.repository.lastMessages(conversationId, RESUME_MESSAGE_COUNT);
  const messageId = deps.repository.addMessage(conversationId, "user", message.text);
  // The check above was only a check: the claim decides, atomically (another message may have taken a file).
  const claim: ClaimResult = pending.length === 0
    ? { status: "claimed", attachments: [] }
    : await deps.attachments.claim(person.id, message.attachments ?? [], conversationId, messageId);
  if (claim.status !== "claimed") {
    // Nothing of this turn stays: neither its message, nor the conversation created for it.
    if (existing === undefined) deps.repository.delete(conversationId, person.id);
    else deps.repository.deleteMessage(conversationId, messageId);
    yield claim.status === "gone"
      ? { type: "error", requestId: message.requestId, code: "invalid_request", message: ATTACHMENT_GONE }
      : { type: "error", requestId: message.requestId, conversationId, code: "internal", message: ATTACHMENT_FAILED };
    return;
  }
  const attached = claim.attachments;

  const model = chooseModel(message.model, message.text);
  const sheet = buildSheet(deps.memory.sheetMemories(person.id), person.name);
  const systemPrompt = buildSystemPrompt(person, sheet);
  // The turn's own scope: aborted when it ends for any reason (done, error, exception, cancel), so nothing it
  // asked can be approved, nor run, afterwards.
  const turnScope = new AbortController();
  const turnSignal = AbortSignal.any([signal, turnScope.signal]);
  const turn = new TurnContext({
    person,
    conversationId,
    signal: turnSignal,
    confirm: (request) => ports.confirm({ conversationId, messageId }, request, turnSignal),
  });
  const tools = deps.tools.forTurn(turn);
  const body = [message.text.trim(), describeAttachments(attached, deps.attachments.dirOf(conversationId))]
    .filter((part) => part !== "")
    .join("\n\n");
  const prompt = timestamp(body, new Date(start), deps.timezone);
  // This conversation's folder only (when it has files): the built-in Read may reach nothing else.
  const readableDirs = deps.attachments.readableDirs(conversationId);

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const loggedTools: LoggedToolCall[] = [];
  let sessionId = conversation.sessionId ?? undefined;
  // Existing conversation without a session (lost): re-inject the last exchanges from the first attempt.
  let currentPrompt = sessionId === undefined ? buildResumePrompt(history, prompt) : prompt;
  let error: EngineError | undefined;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      error = undefined;
      let finished = false;

      // Only creating the stream and reading from the engine are "engine errors";
      // a repository failure while handling an event must propagate as is.
      let stream: AsyncIterator<EngineEvent> | undefined;
      try {
        stream = deps.engine.run(
          {
            prompt: currentPrompt, sessionId, model, systemPrompt, tools, guard: createNativeGuard(), readableDirs,
            toolTimeoutMs: ports.confirmationTimeoutMs + TOOL_RUN_BUDGET_MS,
          },
          // The turn's own scope: whatever the engine still does once the turn is over is stopped.
          turnSignal,
        )[Symbol.asyncIterator]();
      } catch (cause) {
        error = toEngineError(cause);
      }

      let drained = false;
      try {
        while (stream !== undefined) {
          let next: IteratorResult<EngineEvent>;
          try {
            next = await stream.next();
          } catch (cause) {
            error = toEngineError(cause);
            break;
          }
          if (next.done === true) break;
          const e = next.value;
          switch (e.type) {
            case "session":
              deps.repository.setSession(conversationId, e.sessionId);
              break;
            case "text":
              text += e.text;
              yield { type: "text_delta", conversationId, text: e.text };
              break;
            case "tool_call":
              loggedTools.push({ callId: e.callId, tool: e.tool, success: null });
              yield { type: "tool_call", conversationId, callId: e.callId, tool: e.tool, label: labelOf(e.tool, tools) };
              break;
            case "tool_result": {
              const call = loggedTools.find((t) => t.callId === e.callId);
              if (call !== undefined) call.success = e.success;
              yield { type: "tool_result", conversationId, callId: e.callId, success: e.success };
              break;
            }
            case "done":
              finished = true;
              inputTokens += e.inputTokens;
              outputTokens += e.outputTokens;
              break;
            case "error":
              error = e;
              break;
          }
        }
        drained = true;
      } finally {
        // Early exit (consumer stopped, repository failure): the turn is over first, so nothing it started may
        // still run while the engine stream is released.
        if (!drained) turnScope.abort();
        await stream?.return?.();
      }

      // Every engine must end a turn with "done" or "error": a silent end is a failure, never an empty success.
      if (error === undefined && !finished && !signal.aborted) {
        error = { type: "error", code: "engine", message: INCOMPLETE_TURN_MESSAGE };
      }

      // Only a session the SDK could not load is dropped: a network or process failure keeps it for the next turn.
      const unreadableSession =
        error?.code === "unreadable_session" && sessionId !== undefined && text === "" && loggedTools.length === 0;
      if (!unreadableSession || signal.aborted) break;
      sessionId = undefined;
      deps.repository.setSession(conversationId, null);
      currentPrompt = buildResumePrompt(history, prompt);
    }
  } finally {
    turnScope.abort();
    // Always store what was said and log the turn, even if the consumer stops.
    const durationMs = deps.clock() - start;
    if (text !== "") deps.repository.addMessage(conversationId, "assistant", text);
    deps.repository.logTurn({
      conversationId, model, inputTokens, outputTokens, durationMs, tools: loggedTools,
      error: signal.aborted ? "annulé" : (error?.message ?? null),
    });
  }

  if (signal.aborted) return;
  const durationMs = deps.clock() - start;
  if (error !== undefined) {
    yield {
      type: "error",
      requestId: message.requestId,
      conversationId,
      // An unreadable session that could not be retried is, for the app, an engine failure.
      code: error.code === "unreadable_session" ? "engine" : error.code,
      message: error.message,
    };
    return;
  }
  yield { type: "done", conversationId, model, inputTokens, outputTokens, durationMs };
}
