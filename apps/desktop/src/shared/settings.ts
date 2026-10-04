import { z } from "zod";
import { DEFAULT_SHORTCUT, isValidAccelerator } from "./accelerator.ts";
import { Point } from "./holo.ts";

export const Accelerator = z.string().max(60).refine(isValidAccelerator, "Invalid shortcut");

/** The app's settings (settings.json). Each field falls back to its default on its own when unreadable. */
export const Settings = z.object({
  shortcut: Accelerator.catch(DEFAULT_SHORTCUT),
  launchAtStartup: z.boolean().catch(false),
  showHolo: z.boolean().catch(true),
  /** Top-left corner of the collapsed Holo window; null until the Holo was moved. */
  holoAnchor: Point.nullable().catch(null),
});
export type Settings = z.infer<typeof Settings>;

/** What a window may change (the Holo position only changes by dragging the Holo). */
export const SettingsPatch = z.strictObject({
  shortcut: Accelerator.optional(),
  launchAtStartup: z.boolean().optional(),
  showHolo: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** The settings, and whether the shortcut is really registered (another app may hold it). */
export const SettingsSnapshot = z.object({ settings: Settings, shortcutActive: z.boolean() });
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

export const SettingsUpdateResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: SettingsSnapshot }),
  z.object({ ok: z.literal(false), reason: z.enum(["invalid", "shortcut_unavailable"]), snapshot: SettingsSnapshot }),
]);
export type SettingsUpdateResult = z.infer<typeof SettingsUpdateResult>;
