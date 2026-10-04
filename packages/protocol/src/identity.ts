import { z } from "zod";

export const PersonId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
export type PersonId = z.infer<typeof PersonId>;

export const Person = z.object({
  id: PersonId,
  name: z.string().min(1).max(60),
});
export type Person = z.infer<typeof Person>;

/** Model requested by the interface: the brain maps it to an Anthropic model id. */
export const Model = z.enum(["sonnet", "opus"]);
export type Model = z.infer<typeof Model>;
