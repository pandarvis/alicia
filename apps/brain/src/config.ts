import { readFileSync } from "node:fs";
import { Person } from "@alicia/protocol";
import { parse } from "yaml";
import { z } from "zod";

const DEFAULT_MODELS = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

/** A time zone the runtime knows (IANA name): the nightly job and the dates shown to Alicia rely on it. */
function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** An exact web origin: http(s)://host[:port], no path, no trailing slash. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

export const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(8780),
  host: z.string().default("0.0.0.0"),
  /** Announce the brain on the local network (mDNS), so the desktop app finds it on first launch. */
  discovery: z.boolean().default(true),
  dataDir: z.string().default("./data"),
  timezone: z
    .string()
    .refine(isTimeZone, { message: "Fuseau horaire inconnu : écrire un nom IANA, par exemple « Europe/Paris »." })
    .default("Europe/Paris"),
  people: z.array(Person).min(1).refine((list) => list.every((p) => p.id !== "common"), {
    message: "« common » est réservé à la mémoire commune : choisis un autre identifiant.",
  }),
  engine: z.object({ mode: z.enum(["subscription", "api_key"]) }),
  models: z
    .object({ sonnet: z.string().min(1), opus: z.string().min(1) })
    .default(DEFAULT_MODELS),
  /** Web pages allowed to call the brain besides the desktop app (the future PWA). None by default. */
  allowedOrigins: z
    .array(z.string().refine(isOrigin, {
      message:
        "Origine invalide : écrire schéma://hôte[:port] en minuscules, sans port par défaut, sans chemin ni barre finale.",
    }))
    .default([]),
  /** Home coordinates for the weather (optional: without them, no weather tool). */
  home: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .optional(),
  /** Google accounts (calendar, Gmail). Absent: the feature is off. The key stays in the environment. */
  google: z.object({ clientSecretFile: z.string().min(1) }).optional(),
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

const SECRET_KEY_BYTES = 32;

/**
 * Key that encrypts Google refresh tokens at rest (AES-256-GCM), from the environment only.
 * Generate with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
 * Error messages never quote the value.
 */
export function readSecretKey(env: Readonly<Record<string, string | undefined>>): Buffer {
  const raw = env["ALICIA_SECRET_KEY"]?.trim() ?? "";
  if (raw === "") {
    throw new Error("ALICIA_SECRET_KEY manquant : 32 octets aléatoires en base64 (voir README, « Comptes Google »).");
  }
  const decoded = Buffer.from(raw, "base64");
  // Buffer.from skips invalid characters: re-encoding must give the same text back.
  const valid = decoded.length === SECRET_KEY_BYTES && decoded.toString("base64") === raw;
  // The key gets its own memory: `decoded` may be a slice of Node's shared pool, wiped right away.
  const key = Buffer.alloc(SECRET_KEY_BYTES);
  if (valid) decoded.copy(key);
  decoded.fill(0);
  if (!valid) {
    throw new Error(
      "ALICIA_SECRET_KEY invalide : il faut exactement 32 octets encodés en base64 (44 caractères, finissant par =).",
    );
  }
  return key;
}
