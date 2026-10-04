import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { type EngineEvent, INCOMPLETE_TURN_MESSAGE } from "../src/engine/engine.ts";
import {
  allowedToolNames,
  buildEnv,
  classifyError,
  toMcpResult,
  toolHandler,
  translateMessage,
  translateTurn,
} from "../src/engine/sdk-engine.ts";
import { defineTool } from "../src/engine/tools.ts";

/** SDK messages carry many fields that are irrelevant here: partial fixtures. */
const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;
const translate = (m: Record<string, unknown>) => [...translateMessage(sdk(m))];

const QUOTA = { type: "error", code: "quota", message: "Je me repose : le quota de l'abonnement est atteint." };
const SECRET = "sk-ant-oat01-tres-secret";

const LIMIT_REJECTED = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } };
const SUCCESS = { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 40, output_tokens: 7 } };
const FAILURE = { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] };

/** Replays messages the way query() would, then optionally throws an exception. */
async function* stream(messages: readonly Record<string, unknown>[], exception?: Error): AsyncGenerator<SDKMessage> {
  for (const m of messages) yield await Promise.resolve(sdk(m));
  if (exception !== undefined) throw exception;
}

async function turn(
  messages: readonly Record<string, unknown>[],
  exception?: Error,
  signal: AbortSignal = new AbortController().signal,
): Promise<EngineEvent[]> {
  const output: EngineEvent[] = [];
  for await (const e of translateTurn(stream(messages, exception), SECRET, signal)) output.push(e);
  return output;
}

describe("buildEnv", () => {
  const PARENT = {
    PATH: "/bin",
    TEMP: "/tmp",
    ANTHROPIC_API_KEY: "old",
    CLAUDE_CODE_OAUTH_TOKEN: "old",
    ANTHROPIC_BASE_URL: "https://elsewhere.example",
    ANTHROPIC_AUTH_TOKEN: "third-party-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    GOOGLE_CLIENT_SECRET: "google",
  };
  const ABSENT = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "GOOGLE_CLIENT_SECRET"];

  test("subscription: allow-list + token only", () => {
    const env = buildEnv(PARENT, { mode: "subscription", token: "j" });
    expect(env).toEqual({ PATH: "/bin", TEMP: "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "j" });
    for (const name of [...ABSENT, "ANTHROPIC_API_KEY"]) expect(env).not.toHaveProperty(name);
  });
  test("API key: allow-list + key only", () => {
    const env = buildEnv(PARENT, { mode: "api_key", key: "k" });
    expect(env).toEqual({ PATH: "/bin", TEMP: "/tmp", ANTHROPIC_API_KEY: "k" });
    for (const name of [...ABSENT, "CLAUDE_CODE_OAUTH_TOKEN"]) expect(env).not.toHaveProperty(name);
  });
  test("allow-listed variables missing from the parent: not created", () => {
    expect(buildEnv({}, { mode: "subscription", token: "j" })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "j" });
  });
});

describe("translateMessage", () => {
  test("init → session", () => {
    expect(translate({ type: "system", subtype: "init", session_id: "s1" })).toEqual([
      { type: "session", sessionId: "s1" },
    ]);
  });
  test("other system message: ignored", () => {
    expect(translate({ type: "system", subtype: "api_retry", session_id: "s1" })).toEqual([]);
  });
  test("text delta → text", () => {
    expect(
      translate({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Bon" } } }),
    ).toEqual([{ type: "text", text: "Bon" }]);
  });
  test("text block of an assistant message: ignored (already received as deltas)", () => {
    expect(translate({ type: "assistant", message: { content: [{ type: "text", text: "Bonjour" }] } })).toEqual([]);
  });
  test("tool call", () => {
    expect(
      translate({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "weather", input: {} }] } }),
    ).toEqual([{ type: "tool_call", callId: "t1", tool: "weather" }]);
  });
  test("tool result (success and failure)", () => {
    expect(
      translate({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "ko", is_error: true },
          ],
        },
      }),
    ).toEqual([
      { type: "tool_result", callId: "t1", success: true },
      { type: "tool_result", callId: "t2", success: false },
    ]);
  });
  test("plain-text user message: ignored", () => {
    expect(translate({ type: "user", message: { role: "user", content: "coucou" } })).toEqual([]);
  });
  test("successful result → done with tokens", () => {
    expect(translate(SUCCESS)).toEqual([{ type: "done", inputTokens: 40, outputTokens: 7 }]);
  });
  test("error result → classified error", () => {
    expect(translate(FAILURE)).toEqual([{ type: "error", code: "engine", message: "Le moteur a échoué : boom" }]);
  });
  test("\"success\" result that is an API error → error with the result's text", () => {
    expect(
      translate({ type: "result", subtype: "success", is_error: true, result: "API Error: 500", api_error_status: 500 }),
    ).toEqual([{ type: "error", code: "engine", message: "Le moteur a échoué : API Error: 500" }]);
  });
  test("API error 429 result → quota, even if the text does not say so", () => {
    expect(
      translate({ type: "result", subtype: "success", is_error: true, result: "Échec", api_error_status: 429 }),
    ).toEqual([QUOTA]);
  });
  test("limit event: nothing on its own (the turn decides)", () => {
    expect(translate(LIMIT_REJECTED)).toEqual([]);
  });
});

describe("translateTurn", () => {
  test("normal turn: session, text, done", async () => {
    expect(
      await turn([
        { type: "system", subtype: "init", session_id: "s1" },
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Bon" } } },
        SUCCESS,
      ]),
    ).toEqual([
      { type: "session", sessionId: "s1" },
      { type: "text", text: "Bon" },
      { type: "done", inputTokens: 40, outputTokens: 7 },
    ]);
  });
  test("rejected limit then an error result with any text → a single quota error", async () => {
    expect(await turn([LIMIT_REJECTED, FAILURE])).toEqual([QUOTA]);
  });
  test("rejected limit then exception → a single quota error", async () => {
    expect(await turn([LIMIT_REJECTED], new Error("spawn ENOENT"))).toEqual([QUOTA]);
  });
  test("rejected limit then success → only done", async () => {
    expect(await turn([LIMIT_REJECTED, SUCCESS])).toEqual([{ type: "done", inputTokens: 40, outputTokens: 7 }]);
  });
  test("non-blocking limit (warning, or covered by overage) then failure → engine error", async () => {
    const warning = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } };
    const covered = { type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "allowed" } };
    expect(await turn([warning, covered, FAILURE])).toEqual([
      { type: "error", code: "engine", message: "Le moteur a échoué : boom" },
    ]);
  });
  test("error result alone → a single engine error, the following exception is swallowed", async () => {
    expect(await turn([FAILURE], new Error("process exited with code 1"))).toEqual([
      { type: "error", code: "engine", message: "Le moteur a échoué : boom" },
    ]);
  });
  test("exception without a result → classified error", async () => {
    expect(await turn([], new Error("spawn ENOENT"))).toEqual([
      { type: "error", code: "engine", message: "Le moteur a échoué : spawn ENOENT" },
    ]);
  });
  test("exception after cancellation: nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await turn([], new Error("aborted"), controller.signal)).toEqual([]);
  });
  test("the active secret is masked in error messages", async () => {
    const events = await turn([], new Error(`échec avec CLAUDE_CODE_OAUTH_TOKEN=${SECRET} et ${SECRET}`));
    expect(events).toEqual([
      {
        type: "error",
        code: "engine",
        message: "Le moteur a échoué : échec avec CLAUDE_CODE_OAUTH_TOKEN=[secret] et [secret]",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
  test("stream ends without a result nor an exception → an explicit engine error, never a done", async () => {
    expect(await turn([{ type: "system", subtype: "init", session_id: "s1" }])).toEqual([
      { type: "session", sessionId: "s1" },
      { type: "error", code: "engine", message: INCOMPLETE_TURN_MESSAGE },
    ]);
  });
  test("rejected limit then a silent end → quota", async () => {
    expect(await turn([LIMIT_REJECTED])).toEqual([QUOTA]);
  });
  test("silent end after cancellation: nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await turn([], undefined, controller.signal)).toEqual([]);
  });
  test("the secret is also masked in an error result", async () => {
    const failure = { type: "result", subtype: "error_during_execution", is_error: true, errors: [`clé ${SECRET} refusée`] };
    expect(await turn([failure])).toEqual([
      { type: "error", code: "engine", message: "Le moteur a échoué : clé [secret] refusée" },
    ]);
  });
});

describe("classifyError", () => {
  test("usage limit → quota", () => {
    expect(classifyError("Claude AI usage limit reached|1759590000").code).toBe("quota");
    expect(classifyError("429 rate_limit_error").code).toBe("quota");
    expect(classifyError("Quota exceeded for this organization").code).toBe("quota");
  });
  test("SDK limit-reached texts → quota", () => {
    expect(classifyError("You've hit your session limit · resets 3pm").code).toBe("quota");
    expect(classifyError("You're out of extra usage · resets Oct 7").code).toBe("quota");
  });
  test("everything else → engine, including a disk quota", () => {
    expect(classifyError("spawn ENOENT")).toEqual({ code: "engine", message: "Le moteur a échoué : spawn ENOENT" });
    expect(classifyError("EDQUOT: disk quota exceeded, write").code).toBe("engine");
  });
});

describe("tools", () => {
  test("tool names are reported without the MCP prefix", () => {
    expect(
      translate({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__alicia__memory_search", input: {} }] } }),
    ).toEqual([{ type: "tool_call", callId: "t1", tool: "memory_search" }]);
  });

  test("toolNames lists the allowed MCP names", () => {
    const tool = defineTool({ name: "memory_search", description: "d", input: {}, run: () => Promise.resolve({ text: "" }) });
    expect(allowedToolNames([tool])).toEqual(["mcp__alicia__memory_search"]);
  });

  test("toMcpResult: text content, isError only when the tool failed", () => {
    expect(toMcpResult({ text: "ok" })).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(toMcpResult({ text: "ko", isError: true })).toEqual({ content: [{ type: "text", text: "ko" }], isError: true });
    expect(toMcpResult({ text: "ok", isError: false })).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  test("toolHandler runs the tool with its arguments", async () => {
    const echo = defineTool({
      name: "echo", description: "Répète", input: { word: z.string() },
      run: ({ word }) => Promise.resolve({ text: `écho ${word}` }),
    });
    expect(await toolHandler(echo)({ word: "salut" })).toEqual({ content: [{ type: "text", text: "écho salut" }] });
  });

  test("toolHandler turns an exception into a generic tool error, without its details", async () => {
    const broken = defineTool({
      name: "broken", description: "Casse", input: {},
      run: () => Promise.reject(new Error(`database locked, key ${SECRET}`)),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await toolHandler(broken)({});
    expect(result).toEqual({ content: [{ type: "text", text: "Erreur de l'outil." }], isError: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // The failure is logged for the household admin, without the error message (it may hold data).
    expect(logged).toHaveBeenCalledWith("Tool broken failed (Error)");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
    logged.mockRestore();
  });

  test("toolHandler also catches a synchronous throw", async () => {
    const broken = defineTool({
      name: "broken", description: "Casse", input: {},
      run: () => {
        throw new Error("sync");
      },
    });
    expect(await toolHandler(broken)({})).toEqual({ content: [{ type: "text", text: "Erreur de l'outil." }], isError: true });
  });
});
