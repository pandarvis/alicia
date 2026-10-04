import { z } from "zod";

/** A brain found on the local network (mDNS), offered on the pairing screen. */
export const DiscoveredBrain = z.object({
  name: z.string().min(1).max(80),
  url: z.url(),
  version: z.string().max(40).nullable(),
});
export type DiscoveredBrain = z.infer<typeof DiscoveredBrain>;
