import { prefersReducedMotion } from "svelte/motion";

/**
 * Duration for a Svelte transition: `ms`, or 0 when the user asks for reduced motion.
 * Svelte transitions run through the Web Animations API, which the CSS reduced-motion rule does not stop.
 */
export function motion(ms: number): number {
  return prefersReducedMotion.current ? 0 : ms;
}

/** Scroll behavior for a scroll the user should see happen: instant when reduced motion is preferred. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion.current ? "auto" : "smooth";
}
