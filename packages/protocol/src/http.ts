import { z } from "zod";
import { Person } from "./identity.ts";

export const PairingRequest = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  deviceName: z.string().trim().min(1).max(60),
});
export type PairingRequest = z.infer<typeof PairingRequest>;

export const PairingResponse = z.object({ token: z.string(), person: Person });
export type PairingResponse = z.infer<typeof PairingResponse>;

export const HealthResponse = z.object({ ok: z.literal(true), version: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ConversationSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  updatedAt: z.iso.datetime(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const HistoryMessage = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.iso.datetime(),
});
export type HistoryMessage = z.infer<typeof HistoryMessage>;
