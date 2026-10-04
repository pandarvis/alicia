import {
  app, globalShortcut, Menu, type MenuItemConstructorOptions, nativeImage, Notification, Tray,
} from "electron";
import type { OsIntegration, TrayHandle } from "./os-integration.ts";
import type { TrayAction, TrayItem } from "./tray-menu.ts";

function menuTemplate(items: readonly TrayItem[], onAction: (action: TrayAction) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    const { id } = item;
    if (id === "separator") return { type: "separator" };
    return {
      label: item.label,
      type: item.checked === null ? "normal" : "checkbox",
      checked: item.checked ?? false,
      enabled: item.enabled,
      click: () => {
        onAction(id);
      },
    };
  });
}

/** The real OS: global shortcut, Windows login item, notifications and the notification-area icon. */
export function electronOs(options: { trayIcon: string; notificationIcon: string }): OsIntegration {
  /** Kept until clicked or dismissed: a garbage-collected notification loses its click handler. */
  const shown = new Set<Notification>();
  let tray: Tray | null = null;
  return {
    registerShortcut: (accelerator, run) => {
      try {
        return globalShortcut.register(accelerator, run);
      } catch {
        return false;
      }
    },
    unregisterShortcut: (accelerator) => {
      globalShortcut.unregister(accelerator);
    },
    // Only the installed app registers itself with Windows: a dev build never writes a login item.
    setLoginItem: (openAtLogin) => {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] });
    },
    notify: (request) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        title: request.title,
        body: request.body,
        icon: nativeImage.createFromPath(options.notificationIcon),
      });
      shown.add(notification);
      notification.on("click", () => {
        shown.delete(notification);
        request.onClick();
      });
      notification.on("close", () => {
        shown.delete(notification);
      });
      notification.show();
    },
    createTray: (items, onAction, onClick): TrayHandle => {
      const created = new Tray(nativeImage.createFromPath(options.trayIcon));
      created.setToolTip("Alicia");
      created.on("click", () => {
        onClick();
      });
      const update = (next: readonly TrayItem[]): void => {
        created.setContextMenu(Menu.buildFromTemplate(menuTemplate(next, onAction)));
      };
      update(items);
      tray = created;
      return { update };
    },
    dispose: () => {
      globalShortcut.unregisterAll();
      tray?.destroy();
      tray = null;
    },
  };
}
