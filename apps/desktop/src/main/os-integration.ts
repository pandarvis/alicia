import type { TrayAction, TrayItem } from "./tray-menu.ts";

export interface NotificationRequest {
  title: string;
  body: string;
  onClick: () => void;
}

export interface TrayHandle {
  update(items: readonly TrayItem[]): void;
}

/** Everything that reaches outside the app's own windows: Electron in the app, a recorder in tests. */
export interface OsIntegration {
  /** False when the accelerator is invalid or already held by another application. */
  registerShortcut(accelerator: string, run: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  setLoginItem(openAtLogin: boolean): void;
  /** Whether Windows starts the app at login; null when it cannot tell (only the installed app has a login item). */
  isLoginItemEnabled(): boolean | null;
  notify(request: NotificationRequest): void;
  createTray(items: readonly TrayItem[], onAction: (action: TrayAction) => void, onClick: () => void): TrayHandle;
  dispose(): void;
}
