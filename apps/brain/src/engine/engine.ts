import type { Model } from "@alicia/protocol";
import type { ToolDefinition } from "./tools.ts";

/** Decision on a built-in tool call. */
export type NativeDecision = { allow: true } | { allow: false; reason: string };

/** Gatekeeper of the SDK's built-in tools (Read, WebFetch, WebSearch, Skill) for one turn. */
export interface NativeToolGuard {
  /** Called before every built-in tool call; may wait for the person's confirmation. */
  check(tool: string, input: unknown, signal: AbortSignal): Promise<NativeDecision>;
  /** French reminder added after a built-in tool brought outside content in (undefined: nothing to add). */
  reminder(tool: string, input: unknown): string | undefined;
}

export interface EngineRequest {
  prompt: string;
  /** SDK session to resume; undefined = new session. */
  sessionId: string | undefined;
  model: Model;
  systemPrompt: string;
  /** Tools available for this turn (bound to the person speaking, confirmations included). */
  tools: readonly ToolDefinition[];
  /** Decides on the built-in tools for this turn. */
  guard: NativeToolGuard;
  /** Existing directories the built-in Read may reach besides the workspace (this conversation's attachments). */
  readableDirs: readonly string[];
  /**
   * How long one of our tool calls may take, a confirmation included (the answer's delay plus the tool's own
   * run): the engine must never cut a call before that.
   */
  toolTimeoutMs: number;
}

/** What the engine reports during a turn, independently of the SDK. */
export type EngineEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; tool: string }
  | { type: "tool_result"; callId: string; success: boolean }
  | { type: "done"; inputTokens: number; outputTokens: number }
  /**
   * "unreadable_session": the SDK could not resume the requested session (unknown or unreadable).
   * Internal to the brain: the chat service retries without a session and never sends this code to the app.
   */
  | { type: "error"; code: "quota" | "engine" | "unreadable_session"; message: string };

/** A turn that stopped without a result: an engine failure, never an empty success. */
export const INCOMPLETE_TURN_MESSAGE = "Le moteur s'est arrêté avant la fin de sa réponse.";

export interface Engine {
  run(request: EngineRequest, signal: AbortSignal): AsyncIterable<EngineEvent>;
}
