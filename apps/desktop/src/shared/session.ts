import { Person } from "@alicia/protocol";
import { z } from "zod";

/** What a paired device remembers: where the brain lives, its device token, who it belongs to. */
export const StoredSession = z.object({
  serverUrl: z.url(),
  token: z.string().min(20).max(200),
  person: Person,
});
export type StoredSession = z.infer<typeof StoredSession>;

/** Outcome of saving a session; the main process reports failures instead of throwing over IPC. */
export const SaveSessionResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(["encryption_unavailable", "invalid_session"]) }),
]);
export type SaveSessionResult = z.infer<typeof SaveSessionResult>;

/** API exposed to the renderer as `window.alicia` by the preload script. */
export interface AliciaBridge {
  getSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession): Promise<SaveSessionResult>;
  clearSession(): Promise<void>;
  deviceName(): Promise<string>;
}

export const IPC = {
  getSession: "session:get",
  saveSession: "session:save",
  clearSession: "session:clear",
  deviceName: "device:name",
} as const;
