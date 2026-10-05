import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export interface GoogleClientSecret {
  clientId: string;
  clientSecret: string;
}

const Installed = z.object({
  installed: z.object({
    client_id: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
    client_secret: z.string().min(1),
  }),
});
const Web = z.object({ web: z.object({}) });

const INVALID = "google_client_secret.json illisible : télécharge-le à nouveau depuis la console Google Cloud.";
const WEB_CLIENT =
  "google_client_secret.json est un client « Application Web » : crée un client OAuth de type « Application de bureau » pour Alicia.";

/** Parses the file downloaded from Google Cloud. Error messages never quote its content. */
export function parseClientSecret(json: string): GoogleClientSecret {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(INVALID);
  }
  const installed = Installed.safeParse(raw);
  if (installed.success) {
    return { clientId: installed.data.installed.client_id, clientSecret: installed.data.installed.client_secret };
  }
  throw new Error(Web.safeParse(raw).success ? WEB_CLIENT : INVALID);
}

/** Reads the file named by `google.clientSecretFile`. */
export function loadClientSecret(path: string): GoogleClientSecret {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `google_client_secret.json introuvable ou illisible (${resolve(path)}) : vérifie google.clientSecretFile dans la config.`,
    );
  }
  return parseClientSecret(text);
}
