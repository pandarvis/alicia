import type { Model } from "@alicia/protocol";
import type { ToolDefinition } from "./tools.ts";

export interface EngineRequest {
  prompt: string;
  /** SDK session to resume; undefined = new session. */
  sessionId: string | undefined;
  model: Model;
  systemPrompt: string;
  /** Tools available for this turn (bound to the person speaking). */
  tools: readonly ToolDefinition[];
}

/** What the engine reports during a turn, independently of the SDK. */
export type EngineEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; tool: string }
  | { type: "tool_result"; callId: string; success: boolean }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; code: "quota" | "engine"; message: string };

export interface Engine {
  run(request: EngineRequest, signal: AbortSignal): AsyncIterable<EngineEvent>;
}
