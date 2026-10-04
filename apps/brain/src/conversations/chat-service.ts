import type { Person, SendMessage, ServerEvent } from "@alicia/protocol";
import { chooseModel } from "../agent/model.ts";
import { buildSystemPrompt, timestamp } from "../agent/system-prompt.ts";
import type { Clock } from "../clock.ts";
import type { Engine, EngineEvent } from "../engine/engine.ts";
import type { Conversation, ConversationRepository, LoggedToolCall, Message } from "./repository.ts";

export interface ChatDependencies {
  repository: ConversationRepository;
  engine: Engine;
  clock: Clock;
  timezone: string;
}

type EngineError = Extract<EngineEvent, { type: "error" }>;

const TITLE_LENGTH = 60;
const RESUME_MESSAGE_COUNT = 10;

function toEngineError(cause: unknown): EngineError {
  return { type: "error", code: "engine", message: cause instanceof Error ? cause.message : String(cause) };
}

export function titleFrom(text: string): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

export function buildResumePrompt(history: readonly Message[], prompt: string): string {
  if (history.length === 0) return prompt;
  const lines = history.map((m) => `${m.role === "user" ? "Utilisateur" : "Alicia"} : ${m.text}`);
  return `Contexte : la conversation précédente n'a pas pu être reprise. Ses derniers échanges :\n${lines.join("\n")}\n\nNouveau message :\n${prompt}`;
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
  yield { type: "conversation", requestId: message.requestId, conversationId };

  const history = deps.repository.lastMessages(conversationId, RESUME_MESSAGE_COUNT);
  deps.repository.addMessage(conversationId, "user", message.text);

  const model = chooseModel(message.model, message.text);
  const systemPrompt = buildSystemPrompt(person);
  const prompt = timestamp(message.text, new Date(start), deps.timezone);

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const tools: LoggedToolCall[] = [];
  let sessionId = conversation.sessionId ?? undefined;
  // Existing conversation without a session (lost): re-inject the last exchanges from the first attempt.
  let currentPrompt = sessionId === undefined ? buildResumePrompt(history, prompt) : prompt;
  let error: EngineError | undefined;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      error = undefined;

      // Only creating the stream and reading from the engine are "engine errors";
      // a repository failure while handling an event must propagate as is.
      let stream: AsyncIterator<EngineEvent> | undefined;
      try {
        stream = deps.engine.run({ prompt: currentPrompt, sessionId, model, systemPrompt }, signal)[
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
              tools.push({ callId: e.callId, tool: e.tool, success: null });
              yield { type: "tool_call", conversationId, callId: e.callId, tool: e.tool };
              break;
            case "tool_result": {
              const call = tools.find((t) => t.callId === e.callId);
              if (call !== undefined) call.success = e.success;
              yield { type: "tool_result", conversationId, callId: e.callId, success: e.success };
              break;
            }
            case "done":
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

      const unreadableSession =
        error?.code === "engine" && sessionId !== undefined && text === "" && tools.length === 0;
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
      conversationId, model, inputTokens, outputTokens, durationMs, tools,
      error: signal.aborted ? "annulé" : (error?.message ?? null),
    });
  }

  if (signal.aborted) return;
  const durationMs = deps.clock() - start;
  if (error !== undefined) {
    yield {
      type: "error", requestId: message.requestId, conversationId, code: error.code, message: error.message,
    };
    return;
  }
  yield { type: "done", conversationId, model, inputTokens, outputTokens, durationMs };
}
