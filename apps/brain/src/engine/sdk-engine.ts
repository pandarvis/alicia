import type { Model } from "@alicia/protocol";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type Options,
  query,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SdkMcpToolDefinition,
  tool,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";
import type { Authentication } from "../config.ts";
import { VERSION } from "../version.ts";
import { type Engine, type EngineEvent, type EngineRequest, INCOMPLETE_TURN_MESSAGE } from "./engine.ts";
import type { ToolDefinition, ToolResult } from "./tools.ts";
import { CONFIRMATION_TIMEOUT_MS } from "../tools/confirmations.ts";

const LIMIT_PATTERN = /usage limit|rate[ _]?limit|(?<!disk )quota (?:exceeded|reached)|too many requests|\b429\b/i;
const QUOTA_MESSAGE = "Je me repose : le quota de l'abonnement est atteint.";
/**
 * What the Claude Code process prints when `resume` names a session it cannot load (strings of the CLI
 * bundled with SDK 0.3.288, relayed by the SDK as "...exited with code 1. stderr: ..."):
 * - "No conversation found with session ID: <id>": the session is unknown;
 * - "Failed to resume session <id>[: <reason>]": it exists but could not be loaded or processed;
 * - "--resume session load failed (...)": the same failure as logged by the CLI, kept in case it reaches stderr.
 * The SDK only keeps the last 2,048 characters of stderr: a very chatty process could push the line out.
 * Trade-off: "Failed to resume session" also covers a transient I/O error while loading the transcript. The
 * session is then dropped and the next turn starts from the database summary: it costs context, never data.
 * Re-check on every SDK update, like USAGE_LIMIT_ERROR_PREFIXES.
 */
const UNREADABLE_SESSION_PATTERN = /No conversation found with session ID|Failed to resume session|--resume session load failed/i;
const UNREADABLE_SESSION_MESSAGE = "La session précédente est illisible.";
const STATUS_TOO_MANY_REQUESTS = 429;
const MASKED_SECRET = "[secret]";

const QUOTA: EngineEvent = { type: "error", code: "quota", message: QUOTA_MESSAGE };

const MCP_SERVER = "alicia";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/** Tool calls may wait for a confirmation: their own deadline comes after the broker's. */
export const CONFIRMATION_BUDGET_MS = CONFIRMATION_TIMEOUT_MS + 60_000;
/** Generic on purpose: an exception may carry paths, SQL or secrets, none of which belongs in the model's context. */
const TOOL_FAILURE = "Erreur de l'outil.";

/**
 * The only parent variables passed to the SDK process (plus the secret of the chosen mode):
 * what it needs to start (paths, profile, temp dirs, Windows system), the locale and the proxy.
 */
const ALLOWED_ENV: readonly string[] = [
  "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
];

export function classifyError(text: string): { code: "quota" | "engine" | "unreadable_session"; message: string } {
  // Checked first: a failed resume happens before any API call, so it cannot be a quota problem.
  if (UNREADABLE_SESSION_PATTERN.test(text)) return { code: "unreadable_session", message: UNREADABLE_SESSION_MESSAGE };
  // USAGE_LIMIT_ERROR_PREFIXES is marked @alpha in the SDK: re-check it on every SDK update.
  const limitReached = LIMIT_PATTERN.test(text) || USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.includes(prefix));
  return limitReached
    ? { code: "quota", message: QUOTA_MESSAGE }
    : { code: "engine", message: `Le moteur a échoué : ${text}` };
}

/** Limit rejected, and paid overage does not take over. */
function isBlockingLimit(info: SDKRateLimitInfo): boolean {
  return info.status === "rejected" && info.overageStatus !== "allowed" && info.overageStatus !== "allowed_warning";
}

function mask(text: string, secret: string): string {
  return secret === "" ? text : text.replaceAll(secret, MASKED_SECRET);
}

function secretOf(auth: Authentication): string {
  return auth.mode === "subscription" ? auth.token : auth.key;
}

/** Environment of the SDK process: the allow-list, plus a single secret, the one of the chosen mode. */
export function buildEnv(
  base: Readonly<Record<string, string | undefined>>,
  auth: Authentication,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of ALLOWED_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  if (auth.mode === "subscription") env["CLAUDE_CODE_OAUTH_TOKEN"] = auth.token;
  else env["ANTHROPIC_API_KEY"] = auth.key;
  return env;
}

/** The names under which the SDK exposes our tools (and the only ones allowed). */
export function allowedToolNames(tools: readonly ToolDefinition[]): string[] {
  return tools.map((t) => `${MCP_PREFIX}${t.name}`);
}

function toolLabel(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** MCP tool result (the SDK's `CallToolResult`, without depending on the MCP SDK directly). */
export type McpToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

export function toMcpResult(result: ToolResult): McpToolResult {
  return { content: [{ type: "text", text: result.text }], ...(result.isError === true ? { isError: true } : {}) };
}

/**
 * MCP handler of a tool. A failing tool must not end the turn: its exception becomes
 * a generic tool error the model can react to.
 */
export function toolHandler<Shape extends ToolDefinition["input"]>(
  definition: ToolDefinition<Shape>,
): (args: Parameters<ToolDefinition<Shape>["run"]>[0]) => Promise<McpToolResult> {
  return async (args) => {
    try {
      return toMcpResult(await definition.run(args));
    } catch (error) {
      // Logged without its message: it may contain household data.
      console.error(`Tool ${definition.name} failed (${error instanceof Error ? error.name : typeof error})`);
      return { content: [{ type: "text", text: TOOL_FAILURE }], isError: true };
    }
  };
}

/** In-process MCP server exposing the tools of a turn. */
export function toolServer(tools: readonly ToolDefinition[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER,
    version: VERSION,
    // Never hidden behind tool search (built-in tools, ToolSearch included, are disabled).
    alwaysLoad: true,
    // A call may wait for the person's answer (up to 5 min): never cut before the broker settles it.
    timeout: CONFIRMATION_BUDGET_MS,
    tools: tools.map((definition) =>
      tool(definition.name, definition.description, definition.input, toolHandler(definition)),
    ),
  });
}

/** Stateless translation of a single message. Usage limits are handled by `translateTurn`. */
export function* translateMessage(m: SDKMessage): Generator<EngineEvent> {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") yield { type: "session", sessionId: m.session_id };
      return;
    case "stream_event":
      if (m.event.type === "content_block_delta" && m.event.delta.type === "text_delta") {
        yield { type: "text", text: m.event.delta.text };
      }
      return;
    case "assistant":
      for (const block of m.message.content) {
        if (block.type === "tool_use") yield { type: "tool_call", callId: block.id, tool: toolLabel(block.name) };
      }
      return;
    case "user": {
      const content = m.message.content;
      if (typeof content === "string") return;
      for (const block of content) {
        if (block.type === "tool_result") {
          yield { type: "tool_result", callId: block.tool_use_id, success: block.is_error !== true };
        }
      }
      return;
    }
    case "result":
      if (m.subtype === "success" && !m.is_error) {
        yield { type: "done", inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens };
      } else if (m.subtype === "success") {
        // "success" + is_error: the turn ended on an API error, whose text is in `result`.
        yield m.api_error_status === STATUS_TOO_MANY_REQUESTS ? QUOTA : { type: "error", ...classifyError(m.result) };
      } else {
        yield { type: "error", ...classifyError(m.errors.join(" ")) };
      }
      return;
    default:
      return;
  }
}

/**
 * Translation of a whole turn: at most one error, never alongside a "done".
 * A rejected limit is remembered: if the turn then fails (error result or exception),
 * the error is "quota"; if it succeeds, it is forgotten. The secret is masked in errors.
 * Every turn ends with exactly one "done" or one "error", unless cancelled.
 */
export async function* translateTurn(
  messages: AsyncIterable<SDKMessage>,
  secret: string,
  signal: AbortSignal,
): AsyncGenerator<EngineEvent> {
  let limitRejected = false;
  let resultSeen = false;
  const toError = (e: EngineEvent): EngineEvent =>
    limitRejected ? QUOTA : e.type === "error" ? { ...e, message: mask(e.message, secret) } : e;

  try {
    for await (const m of messages) {
      if (m.type === "rate_limit_event") {
        if (isBlockingLimit(m.rate_limit_info)) limitRejected = true;
        continue;
      }
      if (m.type === "result") {
        if (resultSeen) continue;
        resultSeen = true;
      }
      for (const e of translateMessage(m)) yield e.type === "error" ? toError(e) : e;
    }
  } catch (cause) {
    if (!resultSeen && !signal.aborted) {
      const text = cause instanceof Error ? cause.message : String(cause);
      yield toError({ type: "error", ...classifyError(text) });
    }
    return;
  }
  // The stream ended quietly without a result: say so, rather than let the turn look like a success.
  if (!resultSeen && !signal.aborted) yield toError({ type: "error", code: "engine", message: INCOMPLETE_TURN_MESSAGE });
}

export interface SdkEngineParams {
  auth: Authentication;
  models: Readonly<Record<Model, string>>;
  workspaceDir: string;
}

export class SdkEngine implements Engine {
  readonly #params: SdkEngineParams;

  constructor(params: SdkEngineParams) {
    this.#params = params;
  }

  async *run(request: EngineRequest, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });

    const { auth } = this.#params;
    const options: Options = {
      model: this.#params.models[request.model],
      systemPrompt: request.systemPrompt,
      cwd: this.#params.workspaceDir,
      settingSources: [],
      strictMcpConfig: true,
      // Built-in Claude Code tools stay disabled; only our MCP tools are allowed, everything else is refused.
      tools: [],
      allowedTools: allowedToolNames(request.tools),
      disallowedTools: ["ListMcpResourcesTool", "ReadMcpResourceTool"],
      // Explicit: no classifier-driven mode; the deny-all canUseTool is the only gate besides allowedTools.
      permissionMode: "default",
      ...(request.tools.length > 0 ? { mcpServers: { [MCP_SERVER]: toolServer(request.tools) } } : {}),
      includePartialMessages: true,
      canUseTool: () => Promise.resolve({ behavior: "deny", message: "Cet outil n'est pas disponible." }),
      env: buildEnv(process.env, auth),
      abortController: controller,
      ...(request.sessionId !== undefined ? { resume: request.sessionId } : {}),
    };

    try {
      yield* translateTurn(query({ prompt: request.prompt, options }), secretOf(auth), signal);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
