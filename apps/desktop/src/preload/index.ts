import { contextBridge, ipcRenderer } from "electron";
import { type AliciaBridge, IPC, SaveSessionResult, StoredSession } from "../shared/session.ts";

const bridge: AliciaBridge = {
  async getSession() {
    const raw: unknown = await ipcRenderer.invoke(IPC.getSession);
    const parsed = StoredSession.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  async saveSession(session) {
    const raw: unknown = await ipcRenderer.invoke(IPC.saveSession, session);
    const parsed = SaveSessionResult.safeParse(raw);
    return parsed.success ? parsed.data : { ok: false, reason: "invalid_session" };
  },
  async clearSession() {
    await ipcRenderer.invoke(IPC.clearSession);
  },
  async deviceName() {
    const raw: unknown = await ipcRenderer.invoke(IPC.deviceName);
    return typeof raw === "string" ? raw : "PC";
  },
};

contextBridge.exposeInMainWorld("alicia", bridge);
