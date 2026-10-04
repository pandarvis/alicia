import { hostname } from "node:os";
import { SendMessage } from "@alicia/protocol";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { z } from "zod";
import { INVOKE } from "../shared/bridge.ts";
import type { SaveSessionResult, StoredSession } from "../shared/session.ts";
import type { Surface } from "../shared/surface.ts";
import type { BrainHub } from "./brain-hub.ts";
import type { Presence } from "./presence.ts";
import type { WindowManager } from "./windows.ts";

export interface IpcDependencies {
  /** Only our own page (any surface) may call the main process. */
  isTrusted(event: IpcMainInvokeEvent): boolean;
  session: { get(): StoredSession | null; save(raw: unknown): SaveSessionResult; clear(): void };
  windows: WindowManager;
  hub: BrainHub;
  presence: Presence;
}

const NONE = z.undefined();

/** Every page → main process call: sender checked, payload validated by Zod, then handled. */
export function registerIpc(deps: IpcDependencies): void {
  function handle<A>(channel: string, schema: z.ZodType<A>, run: (arg: A, sender: WebContents) => unknown): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, raw: unknown) => {
      if (!deps.isTrusted(event)) throw new Error("Untrusted IPC sender");
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error(`Invalid IPC payload on ${channel}`);
      return run(parsed.data, event.sender);
    });
  }

  function surfaceOf(sender: WebContents): Surface {
    const surface = deps.windows.surfaceOf(sender);
    if (surface === undefined) throw new Error("IPC from an unknown window");
    return surface;
  }

  handle(INVOKE.getSession, NONE, () => deps.session.get());
  // An invalid session is answered with a reason, not an exception (the pairing screen explains it).
  handle(INVOKE.saveSession, z.unknown(), (raw) => deps.session.save(raw));
  handle(INVOKE.clearSession, NONE, () => {
    deps.session.clear();
  });
  handle(INVOKE.deviceName, NONE, () => hostname());
  handle(INVOKE.brainStatus, NONE, () => deps.hub.status);
  handle(INVOKE.brainSend, SendMessage, (message, sender) => deps.hub.send(message, surfaceOf(sender)));
  handle(INVOKE.presenceGet, NONE, () => deps.presence.mood);
  handle(INVOKE.presenceTyping, NONE, () => {
    deps.presence.typing();
  });
}
