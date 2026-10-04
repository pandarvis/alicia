import { hostname } from "node:os";
import { SendMessage } from "@alicia/protocol";
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { z } from "zod";
import { INVOKE } from "../shared/bridge.ts";
import { DragDelta } from "../shared/holo.ts";
import type { SaveSessionResult, StoredSession } from "../shared/session.ts";
import { SettingsPatch, type SettingsUpdateResult } from "../shared/settings.ts";
import type { Surface } from "../shared/surface.ts";
import type { BrainHub } from "./brain-hub.ts";
import type { BrainDiscovery } from "./discovery.ts";
import { mayReadSession } from "./event-routing.ts";
import type { Presence } from "./presence.ts";
import type { SettingsController } from "./settings-controller.ts";
import type { WindowManager } from "./windows.ts";

export interface IpcDependencies {
  /** Only our own page (any surface) may call the main process. */
  isTrusted(event: IpcMainInvokeEvent): boolean;
  session: { get(): StoredSession | null; paired(): boolean; save(raw: unknown): SaveSessionResult; clear(): void };
  windows: WindowManager;
  hub: BrainHub;
  presence: Presence;
  settings: SettingsController;
  discovery: BrainDiscovery;
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

  // The device token only reaches the windows that need it.
  handle(INVOKE.getSession, NONE, (_none, sender) => {
    if (!mayReadSession(surfaceOf(sender))) throw new Error("Session not available to this window");
    return deps.session.get();
  });
  handle(INVOKE.paired, NONE, () => deps.session.paired());
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
  handle(INVOKE.appVersion, NONE, () => app.getVersion());

  function mainOnly(sender: WebContents): void {
    if (surfaceOf(sender) !== "main") throw new Error("Main window only");
  }

  /** The Holo's own calls are refused from any other window. */
  function holoOnly(sender: WebContents): void {
    if (surfaceOf(sender) !== "holo") throw new Error("Holo only");
  }

  handle(INVOKE.hideSelf, NONE, (_none, sender) => {
    deps.windows.hideSelf(sender);
  });
  handle(INVOKE.holoDragStart, NONE, (_none, sender) => {
    holoOnly(sender);
    deps.windows.holoDragStart();
  });
  handle(INVOKE.holoDragTo, DragDelta, (delta, sender) => {
    holoOnly(sender);
    deps.windows.holoDragTo(delta);
  });
  handle(INVOKE.holoDragEnd, NONE, (_none, sender) => {
    holoOnly(sender);
    const anchor = deps.windows.holoDragEnd();
    if (anchor !== null) deps.settings.setHoloAnchor(anchor);
  });
  handle(INVOKE.holoSetExpanded, z.boolean(), (expanded, sender) => {
    holoOnly(sender);
    return deps.windows.setHoloExpanded(expanded);
  });
  handle(INVOKE.settingsGet, NONE, () => deps.settings.snapshot);
  // An invalid patch is answered as such (the page shows why), not thrown.
  handle(INVOKE.settingsUpdate, z.unknown(), (raw): SettingsUpdateResult => {
    const patch = SettingsPatch.safeParse(raw);
    if (!patch.success) return { ok: false, reason: "invalid", snapshot: deps.settings.snapshot };
    return deps.settings.update(patch.data);
  });
  // Only the pairing screen (main window) looks for brains on the network.
  handle(INVOKE.discoveryStart, NONE, (_none, sender) => {
    mainOnly(sender);
    deps.discovery.start();
    return deps.discovery.brains;
  });
  handle(INVOKE.discoveryStop, NONE, (_none, sender) => {
    mainOnly(sender);
    deps.discovery.stop();
  });
  handle(INVOKE.showMain, NONE, () => {
    deps.windows.showMain();
  });
  handle(INVOKE.openConversation, z.uuid(), (conversationId) => {
    deps.windows.showMain();
    deps.windows.openConversation(conversationId);
  });
}
