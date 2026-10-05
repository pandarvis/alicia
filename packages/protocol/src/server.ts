import { z } from "zod";
import { Model, Person } from "./identity.ts";

export const ErrorCode = z.enum(["quota", "engine", "invalid_request", "unauthenticated", "busy", "internal"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const count = z.number().int().nonnegative();

/** How a confirmation ended: the tool only runs on "approved". */
export const ConfirmationOutcome = z.enum(["approved", "refused", "expired", "cancelled"]);
export type ConfirmationOutcome = z.infer<typeof ConfirmationOutcome>;

/** Everything the brain can send to the app over the WebSocket. */
export const ServerEvent = z.discriminatedUnion("type", [
  /** Sent every 30 s to authenticated apps: browsers hide protocol pings, this proves the brain is alive. */
  z.object({ type: z.literal("heartbeat") }),
  z.object({ type: z.literal("ready"), person: Person }),
  z.object({ type: z.literal("conversation"), requestId: z.uuid(), conversationId: z.uuid() }),
  z.object({ type: z.literal("text_delta"), conversationId: z.uuid(), text: z.string() }),
  z.object({
    type: z.literal("tool_call"), conversationId: z.uuid(), callId: z.string(), tool: z.string(),
    /** French activity line (« Alicia regarde la météo… »), chosen by the brain. */
    label: z.string(),
  }),
  z.object({
    type: z.literal("tool_result"), conversationId: z.uuid(), callId: z.string(), success: z.boolean(),
  }),
  /** Alicia needs a yes before acting; only the connection that started the turn can answer. */
  z.object({
    type: z.literal("confirm_request"),
    conversationId: z.uuid(),
    /** The person's message this question belongs to: the card sits right after it in the conversation. */
    messageId: z.uuid(),
    confirmationId: z.uuid(),
    tool: z.string(),
    /** The French question shown on the card. */
    summary: z.string().min(1).max(500),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("confirm_result"),
    conversationId: z.uuid(),
    confirmationId: z.uuid(),
    outcome: ConfirmationOutcome,
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
