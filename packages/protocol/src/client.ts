import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.ts";
import { Model } from "./identity.ts";

export const AuthenticateMessage = z.strictObject({
  type: z.literal("authenticate"),
  token: z.string().min(20).max(200),
});
export type AuthenticateMessage = z.infer<typeof AuthenticateMessage>;

export const SendMessage = z
  .strictObject({
    type: z.literal("send"),
    requestId: z.uuid(),
    conversationId: z.uuid().optional(),
    text: z.string().max(20_000),
    model: Model.optional(),
    /** Pending uploads (POST /attachments) carried by this message, by id: never a path. */
    attachments: z.array(z.uuid()).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  // Text may only be empty when files are sent.
  .refine((m) => m.text.trim().length > 0 || m.attachments !== undefined, "Empty message");
export type SendMessage = z.infer<typeof SendMessage>;

/** The person's answer to a confirmation card. */
export const ConfirmMessage = z.strictObject({
  type: z.literal("confirm"),
  confirmationId: z.uuid(),
  approved: z.boolean(),
});
export type ConfirmMessage = z.infer<typeof ConfirmMessage>;

/** Everything the app can send to the brain over the WebSocket. */
export const ClientMessage = z.discriminatedUnion("type", [AuthenticateMessage, SendMessage, ConfirmMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;
