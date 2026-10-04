import { readFileSync } from "node:fs";
import { Person } from "@alicia/protocol";
import { parse } from "yaml";
import { z } from "zod";

const DEFAULT_MODELS = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

export const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(8780),
  host: z.string().default("0.0.0.0"),
  dataDir: z.string().default("./data"),
  timezone: z.string().default("Europe/Paris"),
  people: z.array(Person).min(1),
  engine: z.object({ mode: z.enum(["subscription", "api_key"]) }),
  models: z
    .object({ sonnet: z.string().min(1), opus: z.string().min(1) })
    .default(DEFAULT_MODELS),
});
export type Config = z.infer<typeof ConfigSchema>;
export type EngineMode = Config["engine"]["mode"];

export type Authentication =
  | { mode: "subscription"; token: string }
  | { mode: "api_key"; key: string };

export function parseConfig(yamlText: string): Config {
  return ConfigSchema.parse(parse(yamlText));
}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, "utf8"));
}

/** Secrets come from the environment, never from the config file. */
export function readAuthentication(
  mode: EngineMode,
  env: Readonly<Record<string, string | undefined>>,
): Authentication {
  if (mode === "subscription") {
    const token = env["CLAUDE_CODE_OAUTH_TOKEN"];
    if (token === undefined || token === "") {
      throw new Error("CLAUDE_CODE_OAUTH_TOKEN manquant (générez-le avec `claude setup-token`).");
    }
    return { mode, token };
  }
  const key = env["ANTHROPIC_API_KEY"];
  if (key === undefined || key === "") throw new Error("ANTHROPIC_API_KEY manquant.");
  return { mode, key };
}
