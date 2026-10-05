import type { z } from "zod";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** What a tool asks before acting: the card's question, and what exactly the person says yes to. */
export interface ConfirmationAsk {
  /** French question shown on the card. */
  summary: string;
  /**
   * The target as it is when asked (a version, an etag, the text shown…), in any form the tool can compare.
   * `run` gets it back and must do nothing if the target changed meanwhile: what runs is what was approved.
   */
  snapshot: string;
}

/** Handed to `run` once the person said yes. */
export interface Confirmed {
  snapshot: string;
}

/**
 * A tool Alicia can call, independent of the SDK. `run` and `confirmation` are declared as methods on
 * purpose: tools with different input shapes can then live in one `ToolDefinition[]`.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** What the family sees while it runs, in French (« Alicia regarde la météo… »). */
  label: string;
  description: string;
  input: Shape;
  /**
   * Present = the person must say yes first. Returns the question and the snapshot of the target, or null when
   * there is nothing to confirm (e.g. the target does not exist: `run` will say so).
   */
  confirmation?(args: z.infer<z.ZodObject<Shape>>): Promise<ConfirmationAsk | null>;
  /** Its result carries outside content (document, web page, mail): the turn is no longer trusted afterwards. */
  untrustedOutput?: boolean;
  /** `confirmed`: what the person approved (undefined when nothing had to be confirmed). */
  run(args: z.infer<z.ZodObject<Shape>>, confirmed?: Confirmed): Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}
