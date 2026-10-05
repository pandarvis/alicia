import { hostname } from "node:os";
import { ConfirmMessage, SendMessage } from "@alicia/protocol";
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { z } from "zod";
import { INVOKE } from "../shared/bridge.ts";
import { GoogleAuthorizeRequest } from "../shared/google.ts";
import type { SaveSessionResult, StoredSession } from "../shared/session.ts";
import { SettingsPatch, type SettingsUpdateResult } from "../shared/settings.ts";
import type { Surface } from "../shared/surface.ts";
import type { BrainHub } from "./brain-hub.ts";
import type { BrainDiscovery } from "./discovery.ts";
import type { GoogleConsent } from "./google-oauth.ts";
import type { UpdateController } from "./updater.ts";
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
  updates: UpdateController;
  google: GoogleConsent;
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
  // Pairing lives in the main window. An invalid session is answered with a reason, not an exception (the
  // pairing screen explains it).
  handle(INVOKE.saveSession, z.unknown(), (raw, sender) => {
    mainOnly(sender);
    return deps.session.save(raw);
  });
  // Signing out and changing settings belong to the main window (Réglages).
  handle(INVOKE.clearSession, NONE, (_none, sender) => {
    mainOnly(sender);
    deps.session.clear();
  });
  handle(INVOKE.deviceName, NONE, () => hostname());
  handle(INVOKE.brainStatus, NONE, () => deps.hub.status);
  handle(INVOKE.brainSend, SendMessage, (message, sender) => deps.hub.send(message, surfaceOf(sender)));
  // A window may only answer the cards it shows: its own turn's, or a Spotlight turn's for the main window (the
  // hub checks it).
  handle(INVOKE.brainConfirm, ConfirmMessage, (message, sender) => deps.hub.confirm(message, surfaceOf(sender)));
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

  handle(INVOKE.hideSelf, z.number().int().nonnegative(), (showing, sender) => {
    deps.windows.hideSelf(sender, showing);
  });
  handle(INVOKE.holoDragStart, NONE, (_none, sender) => {
    holoOnly(sender);
    deps.windows.holoDragStart();
  });
  handle(INVOKE.holoDragMove, NONE, (_none, sender) => {
    holoOnly(sender);
    deps.windows.holoDragMove();
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
  handle(INVOKE.settingsUpdate, z.unknown(), (raw, sender): SettingsUpdateResult => {
    mainOnly(sender);
    const patch = SettingsPatch.safeParse(raw);
    if (!patch.success) return { ok: false, reason: "invalid", snapshot: deps.settings.snapshot };
    return deps.settings.update(patch.data);
  });
  handle(INVOKE.settingsSuspendShortcut, z.boolean(), (suspended, sender) => {
    mainOnly(sender);
    if (suspended) deps.settings.suspendShortcut();
    else deps.settings.resumeShortcut();
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
  handle(INVOKE.updatesStatus, NONE, () => deps.updates.status);
  handle(INVOKE.updatesInstall, NONE, () => {
    deps.updates.install();
  });
  handle(INVOKE.showMain, NONE, () => {
    deps.windows.showMain();
  });
  handle(INVOKE.openConversation, z.uuid(), (conversationId) => {
    deps.windows.showMain();
    deps.windows.openConversation(conversationId);
  });
  // The Holo's « Reconnecter le compte » card: Google's consent runs from the main window's Comptes screen only.
  handle(INVOKE.reconnectAccount, z.uuid(), (accountId, sender) => {
    holoOnly(sender);
    deps.windows.showMain();
    deps.windows.reconnectAccount(accountId);
  });
  // Google accounts are connected from the Comptes screen only; the main process builds the consent URL itself.
  handle(INVOKE.googleAuthorize, GoogleAuthorizeRequest, (request, sender) => {
    mainOnly(sender);
    return deps.google.authorize(request);
  });
  handle(INVOKE.googleCancel, NONE, (_none, sender) => {
    mainOnly(sender);
    deps.google.cancel();
  });
}
