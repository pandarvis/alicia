import type { Person, SendMessage, ServerEvent } from "@alicia/protocol";
import { chooseModel } from "../agent/model.ts";
import { buildSystemPrompt, timestamp } from "../agent/system-prompt.ts";
import type { Clock } from "../clock.ts";
import { type Engine, type EngineEvent, INCOMPLETE_TURN_MESSAGE } from "../engine/engine.ts";
import { buildSheet } from "../memory/sheet.ts";
import type { MemoryStore } from "../memory/store.ts";
import { labelOf, type ToolCatalog } from "../tools/catalog.ts";
import type { Conversation, ConversationRepository, LoggedToolCall, Message } from "./repository.ts";

export interface ChatDependencies {
  repository: ConversationRepository;
  engine: Engine;
  memory: MemoryStore;
  /** Tool providers; each turn builds its tools from them. */
  tools: ToolCatalog;
  clock: Clock;
  timezone: string;
}

type EngineError = Extract<EngineEvent, { type: "error" }>;

const TITLE_LENGTH = 60;
const RESUME_MESSAGE_COUNT = 10;
const RESUME_MESSAGE_CHARS = 1_000;
const RESUME_TOTAL_CHARS = 8_000;
const RESUME_HEADER = "Contexte : la conversation précédente n'a pas pu être reprise. Ses derniers échanges :";

/**
 * At most `max` UTF-16 units, the ellipsis included when cut. Never splits a surrogate pair: an emoji
 * cut in half would leave an invalid character in the title or the prompt.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd8_00 && last <= 0xdb_ff) end -= 1;
  return `${text.slice(0, end)}…`;
}

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
): AsyncGenerator<ServerEvent> {
  const start = deps.clock();

  let conversation: Conversation;
  if (message.conversationId !== undefined) {
    const found = deps.repository.get(message.conversationId, person.id);
    if (found === undefined) {
      yield {
        type: "error", requestId: message.requestId, code: "invalid_request", message: "Conversation introuvable.",
      };
      return;
    }
    conversation = found;
  } else {
    conversation = deps.repository.create(person.id, titleFrom(message.text));
  }
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
  deps.repository.addMessage(conversationId, "user", message.text);

  const model = chooseModel(message.model, message.text);
  const sheet = buildSheet(deps.memory.sheetMemories(person.id), person.name);
  const systemPrompt = buildSystemPrompt(person, sheet);
  const tools = deps.tools.forTurn({ person, conversationId });
  const prompt = timestamp(message.text, new Date(start), deps.timezone);

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
        stream = deps.engine.run({ prompt: currentPrompt, sessionId, model, systemPrompt, tools }, signal)[
          Symbol.asyncIterator
        ]();
      } catch (cause) {
        error = toEngineError(cause);
      }

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
      } finally {
        // Early exit (consumer stopped, repository failure): release the engine stream.
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
