import type { Model } from "@alicia/protocol";
import { resolve } from "node:path";
import {
  type CanUseTool,
  createSdkMcpServer,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  query,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKSystemMessage,
  type SdkMcpToolDefinition,
  type Settings,
  tool,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";
import type { Authentication } from "../config.ts";
import { VERSION } from "../version.ts";
import {
  type Engine, type EngineEvent, type EngineRequest, INCOMPLETE_TURN_MESSAGE, type NativeDecision, type NativeToolGuard,
} from "./engine.ts";
import type { ToolDefinition, ToolResult } from "./tools.ts";

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

/** The SDK's built-in tools Alicia may use; everything else (terminal, edits, agents…) does not exist for her. */
export const NATIVE_TOOLS = ["WebSearch", "WebFetch", "Read", "Skill"] as const;
/** Built-in tools needing no check. Read and WebFetch stay out: only the hook can allow them. */
const UNCHECKED_NATIVE = ["WebSearch"];
const NOT_AVAILABLE = "Cet outil n'est pas disponible.";

/**
 * Settings the brain forces on the SDK process (flag layer, above any settings file): no CLAUDE.md found
 * around the workspace, no auto-memory, no shell inside skills, no file read outside the working directories, nothing
 * synced from the claude.ai account (skills, plugins, connectors). Frozen: no code path may loosen it.
 */
function isolationSettings(): Readonly<Settings> {
  const settings: Settings = {
    claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"],
    autoMemoryEnabled: false,
    disableSkillShellExecution: true,
    permissions: { blockReadsOutsideWorkingDirectories: true },
    syncClaudeAiPlugins: false,
    syncClaudeAiSkills: false,
    disableClaudeAiConnectors: true,
  };
  // Every level, so neither the excludes nor the permissions can be changed in place.
  Object.freeze(settings.claudeMdExcludes);
  Object.freeze(settings.permissions);
  return Object.freeze(settings);
}

export const ISOLATION_SETTINGS: Readonly<Settings> = isolationSettings();

/** The backstop: whatever reaches the permission prompt (a hook that failed to decide) is refused. */
const denyAll: CanUseTool = () => Promise.resolve({ behavior: "deny", message: NOT_AVAILABLE });

/** PreToolUse: every built-in tool call goes through the turn's guard; our MCP tools decide in their handler. */
export function preToolUseHook(guard: NativeToolGuard): HookCallback {
  return async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name.startsWith(MCP_PREFIX)) return {};
    let decision: NativeDecision;
    try {
      decision = await guard.check(input.tool_name, input.tool_input, signal);
    } catch {
      decision = { allow: false, reason: NOT_AVAILABLE };
    }
    return {
      hookSpecificOutput: decision.allow
        ? { hookEventName: "PreToolUse", permissionDecision: "allow" }
        : { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
    };
  };
}

/** PostToolUse: after outside content came in through a built-in tool, a reminder that it is data. */
export function postToolUseHook(guard: NativeToolGuard): HookCallback {
  return (input) => {
    if (input.hook_event_name !== "PostToolUse" || input.tool_name.startsWith(MCP_PREFIX)) return Promise.resolve({});
    const reminder = guard.reminder(input.tool_name, input.tool_input);
    return Promise.resolve(
      reminder === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: reminder } },
    );
  };
}

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
export function toolServer(tools: readonly ToolDefinition[], timeoutMs: number): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER,
    version: VERSION,
    // Never hidden behind tool search (built-in tools, ToolSearch included, are disabled).
    alwaysLoad: true,
    // A call may wait for the person's answer, then run: never cut before (EngineRequest.toolTimeoutMs).
    timeout: timeoutMs,
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
  /** Names of the workspace's skills (the only ones the Skill tool accepts). */
  skills: readonly string[];
}

export function buildOptions(request: EngineRequest, params: SdkEngineParams, controller: AbortController): Options {
  return {
    model: params.models[request.model],
    systemPrompt: request.systemPrompt,
    cwd: params.workspaceDir,
    // Project sources only: Alicia's skills in <workspace>/.claude/skills, never the machine's Claude Code config.
    settingSources: ["project"],
    settings: ISOLATION_SETTINGS,
    strictMcpConfig: true,
    tools: [...NATIVE_TOOLS],
    // Allowed outright: our MCP tools (confirmations happen in their handler) and WebSearch. The SDK adds Skill(<name>).
    allowedTools: [...allowedToolNames(request.tools), ...UNCHECKED_NATIVE],
    skills: [...params.skills],
    disallowedTools: ["ListMcpResourcesTool", "ReadMcpResourceTool"],
    // Explicit: no classifier-driven mode; the hook decides, canUseTool refuses whatever reaches it.
    permissionMode: "default",
    additionalDirectories: [...request.readableDirs],
    hooks: {
      // The guard may wait for a confirmation too (seconds here).
      PreToolUse: [{ hooks: [preToolUseHook(request.guard)], timeout: Math.ceil(request.toolTimeoutMs / 1000) }],
      PostToolUse: [{ hooks: [postToolUseHook(request.guard)] }],
    },
    ...(request.tools.length > 0 ? { mcpServers: { [MCP_SERVER]: toolServer(request.tools, request.toolTimeoutMs) } } : {}),
    includePartialMessages: true,
    canUseTool: denyAll,
    env: buildEnv(process.env, params.auth),
    abortController: controller,
    ...(request.sessionId !== undefined ? { resume: request.sessionId } : {}),
  };
}

export interface IsolationExpectation {
  tools: readonly string[];
  skills: readonly string[];
  mode: Authentication["mode"];
  workspaceDir: string;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));
const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/** Compares what the SDK actually loaded (its init message) with what Alicia should have. */
export function checkIsolation(init: SDKSystemMessage, expected: IsolationExpectation): { ok: boolean; lines: string[] } {
  const problems: string[] = [];
  if (!sameSet(init.tools, expected.tools)) problems.push(`Outils : ${init.tools.join(", ")} (attendu : ${expected.tools.join(", ")})`);
  const missing = expected.skills.filter((s) => !init.skills.includes(s));
  if (missing.length > 0) problems.push(`Skills manquants : ${missing.join(", ")}`);
  if (init.plugins.length > 0) problems.push(`Plugins chargés : ${init.plugins.map((p) => p.name).join(", ")}`);
  const servers = init.mcp_servers.map((s) => s.name);
  if (!sameSet(servers, [MCP_SERVER])) problems.push(`Serveurs MCP : ${servers.join(", ")} (attendu : ${MCP_SERVER})`);
  const keySource = expected.mode === "subscription" ? "none" : "ANTHROPIC_API_KEY";
  if (init.apiKeySource !== keySource) problems.push(`Source d'authentification : ${init.apiKeySource} (attendu : ${keySource})`);
  if (!samePath(init.cwd, expected.workspaceDir)) problems.push(`Dossier de travail : ${init.cwd}`);
  if (init.permissionMode !== "default") problems.push(`Mode de permission : ${init.permissionMode} (attendu : default)`);
  const extra = init.skills.filter((s) => !expected.skills.includes(s));
  if (extra.length > 0) problems.push(`Skills inattendus : ${extra.join(", ")}`);
  const agents = init.agents ?? [];
  if (agents.length > 0) problems.push(`Agents chargés : ${agents.join(", ")}`);
  const lines = [
    ...problems.map((p) => `ÉCHEC  ${p}`),
    problems.length === 0 ? "OK     Isolation conforme." : `${problems.length} problème(s).`,
  ];
  return { ok: problems.length === 0, lines };
}

/** Starts a session only to read its init message, then stops it (command check-isolation: real engine). */
export async function readInit(params: SdkEngineParams, request: EngineRequest): Promise<SDKSystemMessage> {
  const controller = new AbortController();
  try {
    for await (const m of query({ prompt: request.prompt, options: buildOptions(request, params, controller) })) {
      if (m.type === "system" && m.subtype === "init") return m;
    }
  } finally {
    controller.abort();
  }
  throw new Error("Aucun message d'initialisation reçu du SDK.");
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

    const options = buildOptions(request, this.#params, controller);

    try {
      yield* translateTurn(query({ prompt: request.prompt, options }), secretOf(this.#params.auth), signal);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
