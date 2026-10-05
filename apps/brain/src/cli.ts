import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { type ClientMessage, type ConfirmationOutcome, PairingResponse, ServerEvent } from "@alicia/protocol";
import WebSocket from "ws";
import { buildSystemPrompt } from "./agent/system-prompt.ts";
import { buildApplication, createSdkEngine, openMemory } from "./application.ts";
import { loadConfig, readAuthentication } from "./config.ts";
import { advertiseBrain, bonjourPublisher, serviceHostname, shouldAdvertise } from "./discovery.ts";
import type { Engine, EngineRequest } from "./engine/engine.ts";
import { importAlice, readAliceMemories, readAliceRules } from "./memory/import-alice.ts";
import { toText } from "./server/ws.ts";
import { VERSION } from "./version.ts";

const HELP = `Usage : pnpm --filter @alicia/brain alicia <commande>

  start                          lance le cerveau
  pair <personne>                affiche un code d'appairage (10 min)
  chat [--url U] [--code C]      discute dans le terminal (jeton : --code ou ALICIA_TOKEN)
  devices                        liste les appareils appairés
  revoke <id>                    révoque un appareil (effet immédiat, même connecté)
  backup                         sauvegarde la base maintenant (garde les 14 plus récentes)
  check-engine                   un appel réel au SDK (consomme un peu de quota)
  import-alice --chroma <chemin> [--rules <chemin>]
                                 importe la mémoire (et les règles) de l'ancienne Alice, sans doublon

La config est lue dans ALICIA_CONFIG (défaut : alicia.config.yaml), les secrets dans l'environnement.`;

const configPath = (): string => resolve(process.env["ALICIA_CONFIG"] ?? "alicia.config.yaml");

/** `pair`, `devices`, `revoke` and `backup` do not need the engine: it must never be called. */
const UNUSED_ENGINE: Engine = {
  run: () => {
    throw new Error("Moteur inutilisé par cette commande.");
  },
};

async function start(): Promise<void> {
  const config = loadConfig(configPath());
  const engine = createSdkEngine(config, readAuthentication(config.engine.mode, process.env));
  const app = await buildApplication(config, engine, { logging: true });
  try {
    await app.server.listen({ port: config.port, host: config.host });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(`Alicia écoute sur ${config.host}:${config.port} (moteur : ${config.engine.mode}).`);
  // The desktop app finds the brain on its pairing screen (mDNS), unless turned off or loopback only.
  const machine = serviceHostname(hostname());
  const advertisement = shouldAdvertise(config)
    ? advertiseBrain(
        { port: config.port, version: VERSION, hostname: machine },
        bonjourPublisher((error) => {
          console.error(`Annonce sur le réseau local impossible : ${error instanceof Error ? error.message : "erreur"}`);
        }),
      )
    : null;
  if (advertisement !== null) console.log(`Annoncée sur le réseau local : « Alicia sur ${machine} ».`);
  // Nightly job (backup, journal rotation); catches up at once if the brain was off at 3:00.
  void app.maintenance.start();
  // Load (first time: download) the memory model now, not in the middle of an answer.
  const warmStart = Date.now();
  app.memory.warmUp().then(
    () => { console.log(`Mémoire prête (${Math.round((Date.now() - warmStart) / 1000)} s).`); },
    (error: unknown) => { console.error(`Modèle de mémoire indisponible pour l'instant : ${error instanceof Error ? error.name : "erreur"}`); },
  );

  // Graceful shutdown: close the WebSockets, the server and the database before exiting.
  const stop = (signal: NodeJS.Signals): void => {
    console.log(`\n${signal} reçu : arrêt d'Alicia…`);
    (advertisement === null ? app.close() : advertisement.stop().then(() => app.close())).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function pair(person: string | undefined): Promise<void> {
  if (person === undefined) throw new Error("Précisez la personne : pair <kevin|elodie>");
  const config = loadConfig(configPath());
  const app = await buildApplication(config, UNUSED_ENGINE);
  try {
    console.log(`Code pour ${person} : ${app.pairing.generateCode(person)} (valable 10 minutes)`);
  } finally {
    await app.close();
  }
}

async function listDevices(): Promise<void> {
  const config = loadConfig(configPath());
  const app = await buildApplication(config, UNUSED_ENGINE);
  try {
    const list = app.pairing.listDevices();
    if (list.length === 0) {
      console.log("Aucun appareil appairé.");
      return;
    }
    const date = (ms: number | null): string =>
      ms === null
        ? "—"
        : new Date(ms).toLocaleString("fr-FR", { timeZone: config.timezone, dateStyle: "short", timeStyle: "short" });
    const nameOf = (id: string): string => config.people.find((p) => p.id === id)?.name ?? id;
    const rows = [
      ["id", "personne", "nom", "créé le", "vu le", "révoqué"],
      ...list.map((d) => [d.id, nameOf(d.personId), d.name, date(d.createdAt), date(d.lastSeenAt), date(d.revokedAt)]),
    ];
    const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
    for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  } finally {
    await app.close();
  }
}

async function revoke(id: string | undefined): Promise<void> {
  if (id === undefined) throw new Error("Précisez l'appareil : revoke <id> (voir « devices »)");
  const config = loadConfig(configPath());
  const app = await buildApplication(config, UNUSED_ENGINE);
  try {
    if (!app.pairing.revokeDevice(id)) throw new Error(`Aucun appareil actif avec l'id ${id}.`);
    console.log(`Appareil ${id} révoqué.`);
  } finally {
    await app.close();
  }
}

async function backup(): Promise<void> {
  const config = loadConfig(configPath());
  const app = await buildApplication(config, UNUSED_ENGINE);
  try {
    // Prints the path it wrote.
    await app.maintenance.runNow();
  } finally {
    await app.close();
  }
}

async function getToken(wsUrl: string, code: string | undefined): Promise<string> {
  if (code === undefined) {
    const token = process.env["ALICIA_TOKEN"];
    if (token === undefined || token === "") throw new Error("Donnez --code <6 chiffres> ou la variable ALICIA_TOKEN.");
    return token;
  }
  const httpUrl = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "/pairing");
  const response = await fetch(httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "Terminal" }),
  });
  if (!response.ok) throw new Error(`Appairage refusé (${response.status}).`);
  const { token } = PairingResponse.parse(await response.json());
  console.log(`Jeton (à garder dans ALICIA_TOKEN) : ${token}`);
  return token;
}

function readEvent(data: WebSocket.RawData): ServerEvent | undefined {
  try {
    const result = ServerEvent.safeParse(JSON.parse(toText(data)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** How a confirmation that ran nothing ended, as the terminal says it. */
const OUTCOME_LABELS: Readonly<Record<Exclude<ConfirmationOutcome, "approved">, string>> = {
  refused: "refusé",
  expired: "expiré",
  cancelled: "annulé",
};

async function chat(url: string, code: string | undefined): Promise<void> {
  const token = await getToken(url, code);
  const ws = new WebSocket(url);
  let conversationId: string | undefined;
  let endTurn: (() => void) | undefined;
  // Confirmation cards are answered in the terminal, once its prompt exists.
  const terminal: { ask?: (question: string) => Promise<string> } = {};
  const isOpen = (): boolean => ws.readyState === WebSocket.OPEN;

  const send = (m: ClientMessage): void => {
    ws.send(JSON.stringify(m));
  };
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    ws.on("message", (data: WebSocket.RawData) => {
      const e = readEvent(data);
      if (e === undefined) return;
      switch (e.type) {
        case "ready":
          console.log(`Connecté en tant que ${e.person.name}. Tape « /quitter » pour sortir.`);
          resolveReady();
          break;
        case "conversation":
          conversationId = e.conversationId;
          process.stdout.write("Alicia : ");
          break;
        case "text_delta":
          process.stdout.write(e.text);
          break;
        case "tool_call":
          process.stdout.write(`\n  [${e.label}]\n`);
          break;
        case "confirm_request": {
          const answer = (approved: boolean): void => {
            if (isOpen()) send({ type: "confirm", confirmationId: e.confirmationId, approved });
          };
          if (terminal.ask === undefined) {
            answer(false);
            break;
          }
          // A closed prompt (Ctrl+C) is a no.
          terminal.ask(`\n  [confirmation] ${e.summary} (o/n) `).then(
            (typed) => {
              answer(/^o(ui)?$/i.test(typed.trim()));
            },
            () => {
              answer(false);
            },
          );
          break;
        }
        case "confirm_result":
          if (e.outcome !== "approved") console.log(`  [${OUTCOME_LABELS[e.outcome]}]`);
          break;
        case "tool_result":
        case "heartbeat":
          break;
        case "done":
          process.stdout.write(`\n  (${e.model}, ${e.inputTokens}→${e.outputTokens} tokens, ${e.durationMs} ms)\n`);
          endTurn?.();
          break;
        case "error":
          // "busy": a turn is already running; print it and hand back control like any other error.
          console.log(`\n  [erreur ${e.code}] ${e.message}`);
          endTurn?.();
          if (e.code === "unauthenticated") rejectReady(new Error(e.message));
          break;
      }
    });
    // Always listen to "error" (otherwise the process crashes); after "ready", rejecting has no effect.
    ws.on("error", rejectReady);
    ws.once("close", () => {
      endTurn?.();
      rejectReady(new Error("Connexion fermée par le cerveau."));
    });
  });
  ws.once("open", () => {
    send({ type: "authenticate", token });
  });
  await ready;

  const reader = createInterface({ input: process.stdin, output: process.stdout });
  terminal.ask = (question) => reader.question(question);
  reader.on("SIGINT", () => {
    reader.close();
  });
  try {
    while (isOpen()) {
      let text: string;
      try {
        text = (await reader.question("\nToi : ")).trim();
      } catch {
        break; // Ctrl+C or Ctrl+D: the reader is closed.
      }
      if (text === "/quitter") break;
      if (text === "" || !isOpen()) continue;
      const turn = new Promise<void>((resolveTurn) => {
        endTurn = resolveTurn;
      });
      send({
        type: "send",
        requestId: randomUUID(),
        text,
        ...(conversationId !== undefined ? { conversationId } : {}),
      });
      await turn;
    }
    if (!isOpen()) console.log("\nConnexion fermée par le cerveau.");
  } finally {
    reader.close();
    ws.close();
  }
}

async function checkEngine(): Promise<void> {
  const config = loadConfig(configPath());
  const engine = createSdkEngine(config, readAuthentication(config.engine.mode, process.env));
  const person = config.people[0];
  if (person === undefined) throw new Error("Aucune personne dans la config.");
  const request: EngineRequest = {
    prompt: "Réponds juste « ok » si tu m'entends.",
    sessionId: undefined,
    model: "sonnet",
    systemPrompt: buildSystemPrompt(person, ""),
    tools: [],
  };
  for await (const e of engine.run(request, new AbortController().signal)) console.log(e);
}

async function importFromAlice(chroma: string | undefined, rules: string | undefined): Promise<void> {
  if (chroma === undefined) {
    throw new Error("Précisez la base de l'ancienne Alice : import-alice --chroma <chemin vers chroma.sqlite3>");
  }
  // Read the sources first: a bad path fails before anything is opened or written.
  const source = {
    memories: readAliceMemories(resolve(chroma)),
    rules: rules === undefined ? [] : readAliceRules(resolve(rules)),
  };
  const { memory, close } = openMemory(loadConfig(configPath()));
  try {
    const report = await importAlice(memory, source);
    console.log(
      `Import : ${report.created} créés, ${report.duplicates} doublons, ${report.skipped} déjà importés, ${report.refused} refusés (secret).`,
    );
  } finally {
    close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string", default: "ws://127.0.0.1:8780/ws" },
      code: { type: "string" },
      chroma: { type: "string" },
      rules: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, argument] = positionals;
  if (values.help === true) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "start":
      return start();
    case "pair":
      return pair(argument);
    case "chat":
      return chat(values.url, values.code);
    case "devices":
      return listDevices();
    case "revoke":
      return revoke(argument);
    case "backup":
      return backup();
    case "check-engine":
      return checkEngine();
    case "import-alice":
      return importFromAlice(values.chroma, values.rules);
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Commande inconnue : ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
