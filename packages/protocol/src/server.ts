import { z } from "zod";
import { Model, Person } from "./identity.ts";

export const ErrorCode = z.enum(["quota", "engine", "invalid_request", "unauthenticated", "busy", "internal"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const count = z.number().int().nonnegative();

/** Everything the brain can send to the app over the WebSocket. */
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), person: Person }),
  z.object({ type: z.literal("conversation"), requestId: z.uuid(), conversationId: z.uuid() }),
  z.object({ type: z.literal("text_delta"), conversationId: z.uuid(), text: z.string() }),
  z.object({
    type: z.literal("tool_call"), conversationId: z.uuid(), callId: z.string(), tool: z.string(),
  }),
  z.object({
    type: z.literal("tool_result"), conversationId: z.uuid(), callId: z.string(), success: z.boolean(),
  }),
  z.object({
    type: z.literal("done"),
    conversationId: z.uuid(),
    model: Model,
    inputTokens: count,
    outputTokens: count,
    durationMs: count,
  }),
  z.object({
    type: z.literal("error"),
    requestId: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    code: ErrorCode,
    message: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
