import { z } from "zod";
import { DEFAULT_SHORTCUT, isValidAccelerator } from "./accelerator.ts";
import { Point } from "./holo.ts";

export const Accelerator = z.string().max(60).refine(isValidAccelerator, "Invalid shortcut");

/** The settings as the main process holds them; strict, for what crosses IPC (main to windows). */
export const StrictSettings = z.strictObject({
  shortcut: Accelerator,
  launchAtStartup: z.boolean(),
  showHolo: z.boolean(),
  /** Top-left corner of the collapsed Holo window; null until the Holo was moved. */
  holoAnchor: Point.nullable(),
});

/** The app's settings read from settings.json: each field falls back to its default on its own when unreadable. */
export const Settings = z.object({
  shortcut: Accelerator.catch(DEFAULT_SHORTCUT),
  launchAtStartup: z.boolean().catch(false),
  showHolo: z.boolean().catch(true),
  holoAnchor: Point.nullable().catch(null),
});
export type Settings = z.infer<typeof StrictSettings>;

/** What a window may change (the Holo position only changes by dragging the Holo). */
export const SettingsPatch = z.strictObject({
  shortcut: Accelerator.optional(),
  launchAtStartup: z.boolean().optional(),
  showHolo: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** The settings, and whether the shortcut is really registered (another app may hold it). Strict: no fallback. */
export const SettingsSnapshot = z.strictObject({ settings: StrictSettings, shortcutActive: z.boolean() });
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

export const SettingsUpdateFailure = z.enum(["invalid", "shortcut_unavailable", "save_failed"]);
export type SettingsUpdateFailure = z.infer<typeof SettingsUpdateFailure>;

/** Why a change was refused, for the Réglages screen. */
export const SETTINGS_UPDATE_MESSAGES: Readonly<Record<SettingsUpdateFailure, string>> = {
  invalid: "Ce réglage n'est pas valable.",
  shortcut_unavailable: "Ce raccourci est déjà pris par une autre application.",
  save_failed: "Impossible d'enregistrer ce réglage sur cet ordinateur ; rien n'a changé.",
};

export const SettingsUpdateResult = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), snapshot: SettingsSnapshot }),
  z.strictObject({ ok: z.literal(false), reason: SettingsUpdateFailure, snapshot: SettingsSnapshot }),
]);
export type SettingsUpdateResult = z.infer<typeof SettingsUpdateResult>;
