import { z } from "zod";

export const TrayAction = z.enum(["open", "toggle-holo", "toggle-startup", "install-update", "quit"]);
export type TrayAction = z.infer<typeof TrayAction>;

export interface TrayItem {
  id: TrayAction | "separator";
  label: string;
  /** null: a plain item; a boolean: a checkbox. */
  checked: boolean | null;
  enabled: boolean;
}

export interface TrayState {
  paired: boolean;
  showHolo: boolean;
  launchAtStartup: boolean;
  updateReady: boolean;
}

/** The notification-area menu (spec: open, show/hide the Holo, launch at startup, quit). */
export function trayMenuItems(state: TrayState): TrayItem[] {
  const items: TrayItem[] = [
    { id: "open", label: "Ouvrir Alicia", checked: null, enabled: true },
    { id: "toggle-holo", label: "Afficher l'Holo", checked: state.showHolo, enabled: state.paired },
    { id: "toggle-startup", label: "Lancer au démarrage", checked: state.launchAtStartup, enabled: true },
  ];
  if (state.updateReady) {
    items.push({ id: "install-update", label: "Redémarrer pour mettre à jour", checked: null, enabled: true });
  }
  items.push(
    { id: "separator", label: "", checked: null, enabled: true },
    { id: "quit", label: "Quitter Alicia", checked: null, enabled: true },
  );
  return items;
}
