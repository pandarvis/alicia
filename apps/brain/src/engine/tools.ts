import type { z } from "zod";

export interface ToolResult {
  text: string;
  isError?: boolean;
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
   * Present = the person must say yes first. Returns the French question shown on the confirmation card,
   * or null when there is nothing to confirm (e.g. the target does not exist: `run` will say so).
   */
  confirmation?(args: z.infer<z.ZodObject<Shape>>): Promise<string | null>;
  /** Its result carries outside content (document, web page, mail): the turn is no longer trusted afterwards. */
  untrustedOutput?: boolean;
  run(args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}
