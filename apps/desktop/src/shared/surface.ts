import { z } from "zod";

/** The three pages of the app: the main window, the detached Holo and the Spotlight bar. */
export const Surface = z.enum(["main", "holo", "spotlight"]);
export type Surface = z.infer<typeof Surface>;

/** The surface named by the page URL (`?surface=`); anything unknown is the main window. */
export function parseSurface(raw: string | null): Surface {
  const parsed = Surface.safeParse(raw);
  return parsed.success ? parsed.data : "main";
}
