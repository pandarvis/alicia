import type { Model } from "@alicia/protocol";

export interface EngineRequest {
  prompt: string;
  /** SDK session to resume; undefined = new session. */
  sessionId: string | undefined;
  model: Model;
  systemPrompt: string;
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
