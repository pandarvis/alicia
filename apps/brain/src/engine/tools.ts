import type { z } from "zod";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/**
 * A tool Alicia can call, independent of the SDK. `run` is declared as a method on purpose:
 * tools with different input shapes can then live in one `ToolDefinition[]`.
 */
export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** What the family sees while it runs, in French (« Alicia regarde la météo… »). */
  label: string;
  description: string;
  input: Shape;
  run(args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}
