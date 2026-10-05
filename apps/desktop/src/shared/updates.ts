import { z } from "zod";

/** Where the automatic update stands (shown in Réglages and the tray). */
export const UpdateStatus = z.discriminatedUnion("state", [
  /** Development build, or not paired: no updates. */
  z.object({ state: z.literal("disabled") }),
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("checking") }),
  z.object({ state: z.literal("up_to_date") }),
  z.object({ state: z.literal("downloading"), percent: z.number().min(0).max(100) }),
  z.object({ state: z.literal("ready"), version: z.string().max(40) }),
  z.object({ state: z.literal("error") }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;
