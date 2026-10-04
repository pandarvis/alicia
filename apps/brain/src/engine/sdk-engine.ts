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
import type { Engine, EngineEvent, EngineRequest } from "./engine.ts";
import type { ToolDefinition, ToolResult } from "./tools.ts";

const LIMIT_PATTERN = /usage limit|rate[ _]?limit|(?<!disk )quota (?:exceeded|reached)|too many requests|\b429\b/i;
const QUOTA_MESSAGE = "Je me repose : le quota de l'abonnement est atteint.";
const STATUS_TOO_MANY_REQUESTS = 429;
const MASKED_SECRET = "[secret]";

const QUOTA: EngineEvent = { type: "error", code: "quota", message: QUOTA_MESSAGE };

const MCP_SERVER = "alicia";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
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

export function classifyError(text: string): { code: "quota" | "engine"; message: string } {
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
function toolServer(tools: readonly ToolDefinition[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER,
    version: VERSION,
    // Never hidden behind tool search (built-in tools, ToolSearch included, are disabled).
    alwaysLoad: true,
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
  }
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
