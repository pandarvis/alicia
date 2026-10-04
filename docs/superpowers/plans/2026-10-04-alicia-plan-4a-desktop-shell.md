# Alicia — Plan 4a : la fenêtre de l'app de bureau — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une app Electron Windows (`apps/desktop`) où l'on s'appaire au cerveau avec le code à 6 chiffres, puis où l'on discute avec Alicia dans la fenêtre de la maquette v2 : barre du haut intégrée, menu des conversations à gauche, chat en direct au centre, bouton Opus, et la nouvelle mascotte papier découpé qui reflète l'état d'Alicia.

**Architecture:** electron-vite (processus principal + preload + interface). Le processus principal garde la session (adresse du cerveau + jeton d'appareil) chiffrée avec `safeStorage` et l'expose par un pont `preload` minimal. L'interface Svelte 5 parle directement au cerveau : HTTP pour l'appairage et l'historique, WebSocket pour le chat, toujours validés par `@alicia/protocol`. La logique (client du cerveau, connexion WebSocket, état du chat) vit dans des modules TypeScript testés sans interface ; les composants Svelte restent minces. Un test de bout en bout lance la vraie app contre un vrai cerveau équipé du `FakeEngine`.

**Tech Stack:** Electron (dernière version), electron-vite, Svelte 5 (runes), TypeScript ~6.0.3 strict, Zod 4 via `@alicia/protocol`, Vitest 5, Playwright (`playwright`, API `_electron`), `@fontsource-variable/nunito`, `sharp` (export des images de la mascotte).

**Spec :** `docs/superpowers/specs/2026-10-04-alicia-socle-design.md`, section « App Electron (bureau) ».

**Hors de ce plan (plan 4b) :** Holo détaché, barre Spotlight, icône de zone de notification, notifications Windows, installateur et mises à jour, découverte du cerveau par mDNS. Les écrans Maison, Souvenirs et Comptes viendront avec leurs plans.

---

## Conventions (à lire avant la tâche 1)

- **Code en anglais** : identifiants, fichiers, commentaires, noms de tests. **Les textes affichés restent en français** (Kévin et Élodie lisent l'interface).
- Imports relatifs avec extension `.ts` dans les modules TypeScript ; les composants s'importent avec `.svelte`.
- TypeScript strict maximal (config de base du dépôt), pas d'`any`, pas d'assertions de type dans `src/`, pas de règles de lint désactivées.
- Pas de syntaxe TypeScript non effaçable (pas d'`enum`, pas de propriétés de paramètres). Champs privés en `#champ`.
- Commits petits, en anglais, terminés par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Ne jamais `git add -A`** : ajouter les fichiers par chemin.
- Toutes les commandes depuis `C:\Sources\alicia` (Git Bash), sauf mention contraire.
- Transitions fluides partout (règle de Kévin) : apparitions en fondu/glissement court, changements d'état de la mascotte en fondu enchaîné, et respect de `prefers-reduced-motion`.

## Structure des fichiers

```
apps/desktop/
├─ package.json, tsconfig.json, electron.vite.config.ts
├─ vitest.config.ts            tests unitaires (logique)
├─ vitest.e2e.config.ts        test de bout en bout (vraie app + vrai cerveau)
├─ scripts/export-mascot.ts    PNG validés → WebP légers
├─ src/shared/session.ts       schéma de session + type du pont
├─ src/main/index.ts           fenêtre, IPC, sécurité
├─ src/main/session-store.ts   session chiffrée sur disque
├─ src/preload/index.ts        pont window.alicia
└─ src/renderer/
   ├─ index.html
   └─ src/
      ├─ main.ts, App.svelte, app.css, env.d.ts
      ├─ assets/mascot/*.webp  9 états de la mascotte
      ├─ lib/brain-client.ts   HTTP : appairage, conversations, historique
      ├─ lib/chat-connection.ts WebSocket : auth, reconnexion
      ├─ lib/mascot.ts         états de la mascotte
      ├─ lib/mascot-images.ts  états → images
      ├─ lib/chat-store.svelte.ts état du chat (runes)
      └─ components/           PairingScreen, Shell, TitleBar, Sidebar,
                               ChatView, Composer, Mascot (.svelte)
└─ test/ (unitaires) et e2e/ (bout en bout)
```

---

### Task 1: La mascotte dans le dépôt

**Files:**
- Modify: `.gitignore`
- Add: `design/mascotte/BRIEF.md` (déjà modifié sur disque), `design/mascotte/papier-decoupe/v2/apercu-128px.png`, `design/mascotte/papier-decoupe/v2/manifest.json`, `design/mascotte/papier-decoupe/v2/verification.json`

Le dossier `design/mascotte/papier-decoupe/` pèse 146 Mo (PNG 2 048 px, sources, archive). On ne versionne que le brief, l'aperçu, le manifeste et la vérification ; les exports légers pour l'app arrivent à la tâche 2.

- [ ] **Step 1: Règles d'exclusion**

Ajouter à la fin de `.gitignore` :
```
apps/desktop/out/

# Mascotte : originaux lourds hors dépôt, seuls l'aperçu et les métadonnées sont versionnés
design/mascotte/papier-decoupe/*
!design/mascotte/papier-decoupe/v2/
design/mascotte/papier-decoupe/v2/*
!design/mascotte/papier-decoupe/v2/apercu-128px.png
!design/mascotte/papier-decoupe/v2/manifest.json
!design/mascotte/papier-decoupe/v2/verification.json
```

- [ ] **Step 2: Vérifier ce que Git verra**

Run: `git status --short --untracked-files=all design/`
Expected: exactement `M design/mascotte/BRIEF.md` (ou `??` s'il n'était pas suivi) et les trois fichiers `v2/apercu-128px.png`, `v2/manifest.json`, `v2/verification.json`. Aucun `.png` d'état, aucun `.zip`, rien de `sources/`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore design/mascotte/BRIEF.md design/mascotte/papier-decoupe/v2/apercu-128px.png design/mascotte/papier-decoupe/v2/manifest.json design/mascotte/papier-decoupe/v2/verification.json
git commit -m "chore(design): track validated mascot brief and preview, ignore heavy originals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Squelette de l'app de bureau

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/scripts/export-mascot.ts`, `apps/desktop/src/renderer/src/assets/mascot/*.webp` (générés)
- Create: `apps/desktop/src/main/index.ts` (version minimale), `apps/desktop/src/preload/index.ts` (vide pour l'instant), `apps/desktop/src/renderer/index.html`, `apps/desktop/src/renderer/src/main.ts`, `apps/desktop/src/renderer/src/App.svelte` (provisoire), `apps/desktop/src/renderer/src/app.css`, `apps/desktop/src/renderer/src/env.d.ts`
- Create: `apps/desktop/src/renderer/src/lib/mascot.ts`, `apps/desktop/test/mascot.test.ts`
- Modify: `eslint.config.js`, `pnpm-workspace.yaml` (builds autorisés)

- [ ] **Step 1: Paquet et dépendances**

`apps/desktop/package.json` :
```json
{
  "name": "@alicia/desktop",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "test:e2e": "electron-vite build && vitest run --config vitest.e2e.config.ts",
    "typecheck": "svelte-check --tsconfig ./tsconfig.json --fail-on-warnings",
    "mascot": "tsx scripts/export-mascot.ts"
  }
}
```

Run :
```bash
pnpm --filter @alicia/desktop add -D electron electron-vite vite svelte @sveltejs/vite-plugin-svelte svelte-check typescript@~6.0.3 @types/node vitest playwright tsx sharp @fontsource-variable/nunito zod @alicia/protocol@workspace:*
pnpm add -w -D eslint-plugin-svelte svelte-eslint-parser globals
```
Tout est en `devDependencies` : electron-vite **embarque** ces modules dans le code produit (seules les `dependencies` restent externes), ce qui évite de faire charger les sources `.ts` de `@alicia/protocol` par Node à l'exécution.
Si pnpm bloque des scripts de build (`electron`, `esbuild`, `sharp`), les autoriser comme pour le cerveau (`pnpm approve-builds electron esbuild sharp`, entrée `allowBuilds` dans `pnpm-workspace.yaml`). Vérifier : `pnpm --filter @alicia/desktop exec electron --version` affiche une version.

- [ ] **Step 2: Configuration TypeScript, Vite et tests**

`apps/desktop/tsconfig.json` :
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": ["node", "vite/client", "svelte"]
  },
  "include": ["src", "test", "e2e", "scripts", "*.config.ts"]
}
```

`apps/desktop/electron.vite.config.ts` :
```ts
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {
    // A sandboxed preload must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: { plugins: [svelte()] },
});
```

`apps/desktop/vitest.config.ts` :
```ts
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  test: { include: ["test/**/*.test.ts"] },
});
```

Vérifier dans la doc de la version d'electron-vite installée (`node_modules/electron-vite/dist/*.d.ts` ou son README) que : la section `preload` accepte ces options ; le processus principal est produit en ESM (`out/main/index.js`) puisque le paquet est `"type": "module"` ; le preload sort en `out/preload/index.cjs`. Ajuster **la config** si les noms diffèrent, et noter l'écart dans le rapport.

- [ ] **Step 3: ESLint pour les fichiers Svelte**

Dans `eslint.config.js`, ajouter la prise en charge des `.svelte` (le reste ne change pas) :
```js
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/drizzle/**", "**/out/**", ".superpowers/**"] },
  ...tseslint.configs.strictTypeChecked,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: tseslint.parser },
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
```
Si l'API exacte d'`eslint-plugin-svelte` diffère (export `configs["flat/recommended"]` selon la version), suivre son README pour la version installée, sans désactiver de règle.

- [ ] **Step 4: Les états de la mascotte (test d'abord)**

`apps/desktop/test/mascot.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import { MASCOT_SOURCE_FILES, MASCOT_STATES } from "../src/renderer/src/lib/mascot.ts";

describe("mascot", () => {
  test("nine states, each mapped to a validated source image", () => {
    expect(MASCOT_STATES).toHaveLength(9);
    expect(Object.keys(MASCOT_SOURCE_FILES).sort()).toEqual([...MASCOT_STATES].sort());
    expect(MASCOT_SOURCE_FILES.idle).toBe("neutre");
    expect(MASCOT_SOURCE_FILES.speaking).toBe("parle");
  });
});
```

Run: `pnpm --filter @alicia/desktop test` → FAIL (module introuvable).

`apps/desktop/src/renderer/src/lib/mascot.ts` :
```ts
/** Alicia's moods, one per validated paper-cut pose (design/mascotte/BRIEF.md). */
export const MASCOT_STATES = [
  "idle", "sleeping", "listening", "thinking", "speaking", "success", "alert", "error", "idea",
] as const;
export type MascotState = (typeof MASCOT_STATES)[number];

/** Source PNG names in design/mascotte/papier-decoupe/v2/. */
export const MASCOT_SOURCE_FILES: Readonly<Record<MascotState, string>> = {
  idle: "neutre",
  sleeping: "veille",
  listening: "ecoute",
  thinking: "reflexion",
  speaking: "parle",
  success: "victoire",
  alert: "alerte",
  error: "bug",
  idea: "idee",
};
```

Run: `pnpm --filter @alicia/desktop test` → PASS.

- [ ] **Step 5: Export des images**

`apps/desktop/scripts/export-mascot.ts` :
```ts
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { MASCOT_SOURCE_FILES, MASCOT_STATES } from "../src/renderer/src/lib/mascot.ts";

const SOURCE_DIR = fileURLToPath(new URL("../../../design/mascotte/papier-decoupe/v2/", import.meta.url));
const OUTPUT_DIR = fileURLToPath(new URL("../src/renderer/src/assets/mascot/", import.meta.url));
/** 2048 → 512: sharp enough at 160 px on a 2x screen, light enough to ship. */
const SIZE = 512;

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const state of MASCOT_STATES) {
  const source = `${SOURCE_DIR}${MASCOT_SOURCE_FILES[state]}.png`;
  const output = `${OUTPUT_DIR}${state}.webp`;
  // Same square canvas for every pose: feet stay anchored, so cross-fades never jump.
  const info = await sharp(source).resize(SIZE, SIZE).webp({ quality: 85, alphaQuality: 90 }).toFile(output);
  console.log(`${state}.webp  ${Math.round(info.size / 1024)} Ko`);
}
```

Run: `pnpm --filter @alicia/desktop mascot`
Expected: 9 lignes, chaque fichier sous ~120 Ko. Ouvrir `idle.webp` pour vérifier la transparence.

- [ ] **Step 6: Fenêtre minimale**

`apps/desktop/src/renderer/src/env.d.ts` :
```ts
/// <reference types="svelte" />
/// <reference types="vite/client" />
```

`apps/desktop/src/renderer/index.html` :
```html
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; connect-src 'self' http: ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
    />
    <title>Alicia</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```
(`connect-src http: ws:` : l'adresse du cerveau est choisie par l'utilisateur, sur le réseau local ou Tailscale.)

`apps/desktop/src/renderer/src/app.css` :
```css
@import "@fontsource-variable/nunito";

:root {
  --night: #16213e;
  --night-deep: #121a32;
  --surface: #1e2a4a;
  --surface-raised: #2a3a62;
  --sage: #8fb9a8;
  --cream: #f3ebdd;
  --cream-muted: #cfc7b8;
  --amber: #d9a45b;
  --muted: #8a93ab;
  --radius: 12px;
  --duration: 180ms;
  --titlebar-height: 40px;
  color-scheme: dark;
  font-family: "Nunito Variable", system-ui, sans-serif;
  color: var(--cream);
  background: var(--night);
}

* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
button, input, textarea { font: inherit; color: inherit; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

`apps/desktop/src/renderer/src/main.ts` :
```ts
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (target === null) throw new Error("Missing #app element");
mount(App, { target });
```

`apps/desktop/src/renderer/src/App.svelte` (provisoire, remplacé tâche 7) :
```svelte
<main><h1>Alicia</h1></main>
```

`apps/desktop/src/preload/index.ts` (provisoire, rempli tâche 3) :
```ts
export {};
```

`apps/desktop/src/main/index.ts` (version minimale, complétée tâche 3) :
```ts
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#16213e",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#121a32", symbolColor: "#f3ebdd", height: 40 },
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 7: Vérifier**

Run: `pnpm --filter @alicia/desktop build && pnpm test && pnpm typecheck && pnpm lint`
Expected: build sans erreur (`out/main/index.js`, `out/preload/index.cjs`, `out/renderer/index.html`), tous les tests et contrôles au vert.
Puis lancer `pnpm --filter @alicia/desktop dev` : une fenêtre sombre « Alicia » s'ouvre, avec les boutons Windows (réduire/agrandir/fermer) en haut à droite sur fond `#121a32`. La fermer.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop eslint.config.js package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(desktop): Electron + Svelte 5 skeleton and paper-cut mascot assets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`apps/desktop` ne contient ni `out/` ni secrets : vérifier avec `git status` avant le commit ; ajouter `apps/desktop/out/` au `.gitignore` racine si besoin.)

---

### Task 3: Session chiffrée et pont preload

**Files:**
- Create: `apps/desktop/src/shared/session.ts`, `apps/desktop/src/main/session-store.ts`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/env.d.ts`
- Test: `apps/desktop/test/session-store.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/session-store.test.ts` :
```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type Cipher, SessionStore } from "../src/main/session-store.ts";
import type { StoredSession } from "../src/shared/session.ts";

const SESSION: StoredSession = {
  serverUrl: "http://192.168.1.20:8780",
  token: "t".repeat(43),
  person: { id: "kevin", name: "Kévin" },
};

/** Reversible fake cipher: enough to prove the file is never plain JSON. */
const fakeCipher = (available = true): Cipher => ({
  isAvailable: () => available,
  encrypt: (text) => Buffer.from(text, "utf8").reverse(),
  decrypt: (data) => Buffer.from(data).reverse().toString("utf8"),
});

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});
const newPath = () => {
  dir = mkdtempSync(join(tmpdir(), "alicia-desktop-"));
  return join(dir, "session.bin");
};

describe("SessionStore", () => {
  test("no file: no session", () => {
    expect(new SessionStore(newPath(), fakeCipher()).load()).toBeNull();
  });

  test("save then load round-trips, and the token never hits the disk in clear", () => {
    const path = newPath();
    const store = new SessionStore(path, fakeCipher());
    store.save(SESSION);
    expect(store.load()).toEqual(SESSION);
    expect(readFileSync(path).toString("utf8")).not.toContain(SESSION.token);
  });

  test("clear removes the session", () => {
    const store = new SessionStore(newPath(), fakeCipher());
    store.save(SESSION);
    store.clear();
    expect(store.load()).toBeNull();
  });

  test("corrupted or tampered file: no session instead of a crash", () => {
    const path = newPath();
    writeFileSync(path, "garbage");
    expect(new SessionStore(path, fakeCipher()).load()).toBeNull();
  });

  test("refuses to save when OS encryption is unavailable", () => {
    expect(() => {
      new SessionStore(newPath(), fakeCipher(false)).save(SESSION);
    }).toThrow(/chiffrement/i);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `pnpm --filter @alicia/desktop test`
Expected: FAIL (modules introuvables).

- [ ] **Step 3: Écrire la session et le stockage**

`apps/desktop/src/shared/session.ts` :
```ts
import { Person } from "@alicia/protocol";
import { z } from "zod";

/** What a paired device remembers: where the brain lives, its device token, who it belongs to. */
export const StoredSession = z.object({
  serverUrl: z.url(),
  token: z.string().min(20).max(200),
  person: Person,
});
export type StoredSession = z.infer<typeof StoredSession>;

/** API exposed to the renderer as `window.alicia` by the preload script. */
export interface AliciaBridge {
  getSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession): Promise<void>;
  clearSession(): Promise<void>;
  deviceName(): Promise<string>;
}

export const IPC = {
  getSession: "session:get",
  saveSession: "session:save",
  clearSession: "session:clear",
  deviceName: "device:name",
} as const;
```

`apps/desktop/src/main/session-store.ts` :
```ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { StoredSession } from "../shared/session.ts";

/** OS-backed encryption (Electron safeStorage in production, a fake in tests). */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export class SessionStore {
  readonly #path: string;
  readonly #cipher: Cipher;

  constructor(path: string, cipher: Cipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  load(): StoredSession | null {
    if (!existsSync(this.#path)) return null;
    try {
      const parsed = StoredSession.safeParse(JSON.parse(this.#cipher.decrypt(readFileSync(this.#path))));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  save(session: StoredSession): void {
    if (!this.#cipher.isAvailable()) {
      throw new Error("Chiffrement du système indisponible : impossible d'enregistrer la session.");
    }
    writeFileSync(this.#path, this.#cipher.encrypt(JSON.stringify(StoredSession.parse(session))));
  }

  clear(): void {
    rmSync(this.#path, { force: true });
  }
}
```

- [ ] **Step 4: Lancer les tests**

Run: `pnpm --filter @alicia/desktop test`
Expected: PASS.

- [ ] **Step 5: Brancher le processus principal et le preload**

`apps/desktop/src/main/index.ts` (remplacement complet) :
```ts
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { IPC, StoredSession } from "../shared/session.ts";
import { SessionStore } from "./session-store.ts";

// Lets the end-to-end test isolate its profile.
const userDataOverride = process.env["ALICIA_USER_DATA"];
if (userDataOverride !== undefined) app.setPath("userData", userDataOverride);

function registerIpc(store: SessionStore): void {
  ipcMain.handle(IPC.getSession, () => store.load());
  ipcMain.handle(IPC.saveSession, (_event, raw: unknown) => {
    store.save(StoredSession.parse(raw));
  });
  ipcMain.handle(IPC.clearSession, () => {
    store.clear();
  });
  ipcMain.handle(IPC.deviceName, () => hostname());
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#16213e",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#121a32", symbolColor: "#f3ebdd", height: 40 },
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  // The app never navigates away nor opens windows; external links go to the browser.
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
}

void app.whenReady().then(() => {
  registerIpc(
    new SessionStore(join(app.getPath("userData"), "session.bin"), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    }),
  );
  createWindow();
});
app.on("window-all-closed", () => {
  app.quit();
});
```

`apps/desktop/src/preload/index.ts` (remplacement complet) :
```ts
import { contextBridge, ipcRenderer } from "electron";
import { type AliciaBridge, IPC, StoredSession } from "../shared/session.ts";

const bridge: AliciaBridge = {
  async getSession() {
    const raw: unknown = await ipcRenderer.invoke(IPC.getSession);
    const parsed = StoredSession.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  async saveSession(session) {
    await ipcRenderer.invoke(IPC.saveSession, session);
  },
  async clearSession() {
    await ipcRenderer.invoke(IPC.clearSession);
  },
  async deviceName() {
    const raw: unknown = await ipcRenderer.invoke(IPC.deviceName);
    return typeof raw === "string" ? raw : "PC";
  },
};

contextBridge.exposeInMainWorld("alicia", bridge);
```

`apps/desktop/src/renderer/src/env.d.ts` (remplacement complet) :
```ts
/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { AliciaBridge } from "../../shared/session.ts";

declare global {
  interface Window {
    alicia: AliciaBridge;
  }
}
```

- [ ] **Step 6: Vérifier et commiter**

Run: `pnpm --filter @alicia/desktop build && pnpm test && pnpm typecheck && pnpm lint`
Expected: au vert.
```bash
git add apps/desktop/src apps/desktop/test
git commit -m "feat(desktop): encrypted device session and minimal preload bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Client HTTP du cerveau

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/brain-client.ts`
- Test: `apps/desktop/test/brain-client.test.ts`

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/brain-client.test.ts` :
```ts
import { describe, expect, test } from "vitest";
import {
  BrainApi, normalizeServerUrl, pair, UnauthorizedError, webSocketUrl,
} from "../src/renderer/src/lib/brain-client.ts";

const CONVERSATION_ID = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

/** Records the last request and answers with a fixed response. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetchFn };
}

describe("server URL", () => {
  test("adds http:// and strips trailing slashes", () => {
    expect(normalizeServerUrl(" 192.168.1.20:8780/ ")).toBe("http://192.168.1.20:8780");
    expect(normalizeServerUrl("https://alicia.ts.net")).toBe("https://alicia.ts.net");
  });
  test("derives the WebSocket URL", () => {
    expect(webSocketUrl("http://127.0.0.1:8780")).toBe("ws://127.0.0.1:8780/ws");
    expect(webSocketUrl("https://alicia.ts.net")).toBe("wss://alicia.ts.net/ws");
  });
});

describe("pair", () => {
  test("success returns a full session", async () => {
    const { calls, fetchFn } = fakeFetch(200, { token: "t".repeat(43), person: { id: "kevin", name: "Kévin" } });
    const result = await pair(fetchFn, "127.0.0.1:8780", "123456", "PC-KEVIN");
    expect(result).toEqual({
      ok: true,
      session: { serverUrl: "http://127.0.0.1:8780", token: "t".repeat(43), person: { id: "kevin", name: "Kévin" } },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8780/pairing");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ code: "123456", deviceName: "PC-KEVIN" }));
  });
  test.each([
    [401, { error: "invalid_code" }, "invalid_code"],
    [429, { error: "too_many_attempts" }, "too_many_attempts"],
    [400, { error: "invalid_request" }, "invalid_request"],
  ] as const)("HTTP %i → %s", async (status, body, reason) => {
    const { fetchFn } = fakeFetch(status, body);
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason });
  });
  test("network failure → unreachable", async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await pair(fetchFn, "127.0.0.1:8780", "123456", "PC")).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("BrainApi", () => {
  const session = { serverUrl: "http://127.0.0.1:8780", token: "t".repeat(43), person: { id: "kevin", name: "Kévin" } };

  test("lists conversations with the device token", async () => {
    const { calls, fetchFn } = fakeFetch(200, [
      { id: CONVERSATION_ID, title: "Volets", updatedAt: "2026-10-04T13:30:00.000Z" },
    ]);
    const list = await new BrainApi(fetchFn, session).listConversations();
    expect(list.map((c) => c.title)).toEqual(["Volets"]);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });
  test("history of a conversation", async () => {
    const { calls, fetchFn } = fakeFetch(200, [
      { id: CONVERSATION_ID, role: "user", text: "Salut", createdAt: "2026-10-04T13:30:00.000Z" },
    ]);
    const history = await new BrainApi(fetchFn, session).history(CONVERSATION_ID);
    expect(history[0]?.text).toBe("Salut");
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8780/conversations/${CONVERSATION_ID}/messages`);
  });
  test("401 → UnauthorizedError (revoked device)", async () => {
    const { fetchFn } = fakeFetch(401, { error: "unauthenticated" });
    await expect(new BrainApi(fetchFn, session).listConversations()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  test("malformed answer is rejected", async () => {
    const { fetchFn } = fakeFetch(200, [{ nope: true }]);
    await expect(new BrainApi(fetchFn, session).listConversations()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `pnpm --filter @alicia/desktop test`
Expected: FAIL.

- [ ] **Step 3: Écrire le client**

`apps/desktop/src/renderer/src/lib/brain-client.ts` :
```ts
import { ConversationSummary, HistoryMessage, PairingResponse } from "@alicia/protocol";
import { z } from "zod";
import type { StoredSession } from "../../../shared/session.ts";

export type PairingFailure = "invalid_code" | "too_many_attempts" | "invalid_request" | "unreachable";
export type PairingResult = { ok: true; session: StoredSession } | { ok: false; reason: PairingFailure };

/** The device token was refused: the device has been revoked. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Device token refused");
    this.name = "UnauthorizedError";
  }
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function webSocketUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/i, "ws")}/ws`;
}

const FAILURE_BY_STATUS: Readonly<Record<number, PairingFailure>> = {
  400: "invalid_request",
  401: "invalid_code",
  429: "too_many_attempts",
};

export async function pair(
  fetchFn: typeof fetch,
  rawServerUrl: string,
  code: string,
  deviceName: string,
): Promise<PairingResult> {
  const serverUrl = normalizeServerUrl(rawServerUrl);
  let response: Response;
  try {
    response = await fetchFn(`${serverUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName }),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) return { ok: false, reason: FAILURE_BY_STATUS[response.status] ?? "unreachable" };
  const parsed = PairingResponse.safeParse(await response.json());
  if (!parsed.success) return { ok: false, reason: "unreachable" };
  return { ok: true, session: { serverUrl, token: parsed.data.token, person: parsed.data.person } };
}

/** Authenticated HTTP calls for a paired device. */
export class BrainApi {
  readonly #fetch: typeof fetch;
  readonly #session: StoredSession;

  constructor(fetchFn: typeof fetch, session: StoredSession) {
    this.#fetch = fetchFn;
    this.#session = session;
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.#get("/conversations", z.array(ConversationSummary));
  }

  history(conversationId: string): Promise<HistoryMessage[]> {
    return this.#get(`/conversations/${encodeURIComponent(conversationId)}/messages`, z.array(HistoryMessage));
  }

  async #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#fetch(`${this.#session.serverUrl}${path}`, {
      headers: { authorization: `Bearer ${this.#session.token}` },
    });
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) throw new Error(`Brain answered HTTP ${response.status} on ${path}`);
    return schema.parse(await response.json());
  }
}
```

- [ ] **Step 4: Lancer les tests, puis commiter**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint`
Expected: PASS.
```bash
git add apps/desktop/src/renderer/src/lib/brain-client.ts apps/desktop/test/brain-client.test.ts
git commit -m "feat(desktop): brain HTTP client (pairing, conversations, history)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Connexion WebSocket

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/chat-connection.ts`
- Test: `apps/desktop/test/chat-connection.test.ts`

Rôle : ouvrir le WebSocket, s'authentifier, relayer les événements validés, se reconnecter avec une attente croissante (1 s, 2 s, 4 s… plafonnée à 30 s), et s'arrêter définitivement si le cerveau refuse l'appareil (fermeture 4401).

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/chat-connection.test.ts` :
```ts
import type { ServerEvent } from "@alicia/protocol";
import { describe, expect, test } from "vitest";
import {
  ChatConnection, type ConnectionStatus, type SocketLike,
} from "../src/renderer/src/lib/chat-connection.ts";

const TOKEN = "t".repeat(43);

/** Fake socket driven by the test. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
  }
  receive(event: unknown): void {
    this.onmessage?.(JSON.stringify(event));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const connection = new ChatConnection({
    url: "ws://127.0.0.1:8780/ws",
    token: TOKEN,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return () => undefined;
    },
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
  });
  return { connection, sockets, timers, events, statuses };
}

describe("ChatConnection", () => {
  test("authenticates on open and becomes ready", () => {
    const { connection, sockets, statuses } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: "authenticate", token: TOKEN })]);
    sockets[0]?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    expect(statuses).toEqual(["connecting", "ready"]);
  });

  test("forwards valid events and drops invalid ones", () => {
    const { connection, sockets, events } = setup();
    connection.start();
    sockets[0]?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    sockets[0]?.receive({ type: "nonsense" });
    sockets[0]?.onmessage?.("not json");
    expect(events.map((e) => e.type)).toEqual(["ready"]);
  });

  test("send only works once ready", () => {
    const { connection, sockets } = setup();
    connection.start();
    sockets[0]?.onopen?.();
    const message = { type: "send" as const, requestId: "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", text: "Salut" };
    expect(connection.send(message)).toBe(false);
    sockets[0]?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    expect(connection.send(message)).toBe(true);
    expect(sockets[0]?.sent.at(-1)).toBe(JSON.stringify(message));
  });

  test("reconnects with growing delays, capped at 30 s, reset after ready", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    for (let i = 0; i < 7; i++) {
      sockets.at(-1)?.onclose?.(1006);
      timers.at(-1)?.run();
    }
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(statuses).toContain("offline");
    sockets.at(-1)?.receive({ type: "ready", person: { id: "kevin", name: "Kévin" } });
    sockets.at(-1)?.onclose?.(1006);
    expect(timers.at(-1)?.ms).toBe(1000);
  });

  test("4401 (device refused) stops for good", () => {
    const { connection, sockets, timers, statuses } = setup();
    connection.start();
    sockets[0]?.onclose?.(4401);
    expect(statuses.at(-1)).toBe("rejected");
    expect(timers).toHaveLength(0);
  });

  test("stop closes the socket and never reconnects", () => {
    const { connection, sockets, timers } = setup();
    connection.start();
    connection.stop();
    expect(sockets[0]?.closedWith).toBe(1000);
    sockets[0]?.onclose?.(1000);
    expect(timers).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `pnpm --filter @alicia/desktop test`
Expected: FAIL.

- [ ] **Step 3: Écrire la connexion**

`apps/desktop/src/renderer/src/lib/chat-connection.ts` :
```ts
import { type SendMessage, ServerEvent } from "@alicia/protocol";

export type ConnectionStatus = "connecting" | "ready" | "offline" | "rejected";

/** The few WebSocket features we use, so tests can drive a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
}

export interface ChatConnectionOptions {
  url: string;
  token: string;
  openSocket: (url: string) => SocketLike;
  /** Runs `run` after `ms`; returns a cancel function. */
  schedule: (run: () => void, ms: number) => () => void;
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
}

const DEVICE_REFUSED = 4401;
const NORMAL_CLOSURE = 1000;
const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/** Adapter from the browser WebSocket to SocketLike. */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    send: (data) => {
      ws.send(data);
    },
    close: (code) => {
      ws.close(code);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => {
    if (typeof event.data === "string") socket.onmessage?.(event.data);
  };
  ws.onclose = (event) => socket.onclose?.(event.code);
  return socket;
}

export class ChatConnection {
  readonly #options: ChatConnectionOptions;
  #socket: SocketLike | null = null;
  #ready = false;
  #attempt = 0;
  #stopped = false;
  #cancelRetry: (() => void) | null = null;

  constructor(options: ChatConnectionOptions) {
    this.#options = options;
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  send(message: SendMessage): boolean {
    if (!this.#ready || this.#socket === null) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelRetry?.();
    this.#socket?.close(NORMAL_CLOSURE);
  }

  #open(): void {
    this.#ready = false;
    this.#options.onStatus("connecting");
    const socket = this.#options.openSocket(this.#options.url);
    this.#socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "authenticate", token: this.#options.token }));
    };
    socket.onmessage = (data) => {
      this.#receive(data);
    };
    socket.onclose = (code) => {
      this.#closed(code);
    };
  }

  #receive(data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerEvent.safeParse(json);
    if (!parsed.success) return;
    if (parsed.data.type === "ready") {
      this.#ready = true;
      this.#attempt = 0;
      this.#options.onStatus("ready");
    }
    this.#options.onEvent(parsed.data);
  }

  #closed(code: number): void {
    this.#ready = false;
    this.#socket = null;
    if (this.#stopped) return;
    if (code === DEVICE_REFUSED) {
      this.#options.onStatus("rejected");
      return;
    }
    this.#options.onStatus("offline");
    const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** this.#attempt);
    this.#attempt++;
    this.#cancelRetry = this.#options.schedule(() => {
      this.#open();
    }, delay);
  }
}
```

- [ ] **Step 4: Lancer les tests, puis commiter**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint`
Expected: PASS.
```bash
git add apps/desktop/src/renderer/src/lib/chat-connection.ts apps/desktop/test/chat-connection.test.ts
git commit -m "feat(desktop): WebSocket connection with auth, validation and backoff reconnect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: L'état du chat et la mascotte

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/chat-store.svelte.ts`
- Test: `apps/desktop/test/chat-store.test.ts`

Rôle : tout l'état du chat dans une classe à runes Svelte 5, testable sans interface. États de la mascotte :

| Situation | Mascotte |
|---|---|
| repos, conversation ouverte | `idle` |
| message envoyé, en attente | `thinking` |
| Alicia utilise un outil | `thinking` |
| le texte arrive | `speaking` |
| réponse terminée | `success` pendant 1,5 s, puis `idle` |
| quota atteint | `sleeping` |
| « Alicia répond déjà » | `alert` pendant 2 s, puis `idle` |
| erreur moteur ou interne | `error` |
| connexion perdue pendant une réponse | `alert` |

- [ ] **Step 1: Écrire les tests**

`apps/desktop/test/chat-store.test.ts` :
```ts
import type { ConversationSummary, HistoryMessage, SendMessage } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { ChatStore } from "../src/renderer/src/lib/chat-store.svelte.ts";

const CONV = "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192";

function setup(history: HistoryMessage[] = []) {
  let counter = 0;
  const sent: SendMessage[] = [];
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  let conversations: ConversationSummary[] = [];
  const store = new ChatStore({
    listConversations: () => Promise.resolve(conversations),
    history: () => Promise.resolve(history),
    send: (m) => {
      sent.push(m);
      return true;
    },
    newId: () => `00000000-0000-4000-8000-00000000000${counter++}`,
    schedule: (run, ms) => {
      const t = { run, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  return {
    store, sent, timers,
    setConversations: (list: ConversationSummary[]) => {
      conversations = list;
    },
  };
}

describe("ChatStore", () => {
  test("starts idle and empty", () => {
    const { store } = setup();
    expect(store.messages).toEqual([]);
    expect(store.mascot).toBe("idle");
    expect(store.busy).toBe(false);
  });

  test("send: user bubble, request without conversation id, mascot thinking", () => {
    const { store, sent } = setup();
    expect(store.send("Salut")).toBe(true);
    expect(store.messages.map((m) => [m.role, m.text])).toEqual([["user", "Salut"]]);
    expect(sent[0]).toEqual({ type: "send", requestId: sent[0]?.requestId, text: "Salut" });
    expect(store.busy).toBe(true);
    expect(store.mascot).toBe("thinking");
  });

  test("blank text or a turn in progress: nothing sent", () => {
    const { store, sent } = setup();
    expect(store.send("   ")).toBe(false);
    store.send("Un");
    expect(store.send("Deux")).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("Opus toggle adds the model", () => {
    const { store, sent } = setup();
    store.opus = true;
    store.send("Réfléchis");
    expect(sent[0]?.model).toBe("opus");
  });

  test("full turn: conversation id, streamed text, done → success then idle", async () => {
    const { store, sent, timers, setConversations } = setup();
    store.send("Salut");
    const requestId = sent[0]?.requestId ?? "";
    setConversations([{ id: CONV, title: "Salut", updatedAt: "2026-10-04T13:30:00.000Z" }]);
    store.handle({ type: "conversation", requestId, conversationId: CONV });
    expect(store.activeId).toBe(CONV);
    store.handle({ type: "text_delta", conversationId: CONV, text: "Bon" });
    expect(store.mascot).toBe("speaking");
    store.handle({ type: "text_delta", conversationId: CONV, text: "jour !" });
    expect(store.messages.at(-1)).toMatchObject({ role: "assistant", text: "Bonjour !", streaming: true });
    store.handle({
      type: "done", conversationId: CONV, model: "sonnet", inputTokens: 1, outputTokens: 2, durationMs: 3,
    });
    expect(store.messages.at(-1)?.streaming).toBe(false);
    expect(store.busy).toBe(false);
    expect(store.mascot).toBe("success");
    timers.at(-1)?.run();
    expect(store.mascot).toBe("idle");
    await vi.waitFor(() => {
      expect(store.conversations.map((c) => c.id)).toEqual([CONV]);
    });
  });

  test("next message continues the same conversation", () => {
    const { store, sent } = setup();
    store.send("Un");
    store.handle({ type: "conversation", requestId: sent[0]?.requestId ?? "", conversationId: CONV });
    store.handle({
      type: "done", conversationId: CONV, model: "sonnet", inputTokens: 0, outputTokens: 0, durationMs: 0,
    });
    store.send("Deux");
    expect(sent[1]?.conversationId).toBe(CONV);
  });

  test("tool call shows an activity line, cleared by the text", () => {
    const { store } = setup();
    store.send("Météo ?");
    store.handle({ type: "tool_call", conversationId: CONV, callId: "t1", tool: "weather" });
    expect(store.activity).toBe("Alicia utilise l'outil « weather »…");
    expect(store.mascot).toBe("thinking");
    store.handle({ type: "text_delta", conversationId: CONV, text: "Beau temps." });
    expect(store.activity).toBeNull();
  });

  test.each([
    ["quota", "sleeping"],
    ["engine", "error"],
    ["internal", "error"],
    ["busy", "alert"],
  ] as const)("error %s → notice and mascot %s", (code, mascot) => {
    const { store, sent } = setup();
    store.send("Salut");
    store.handle({ type: "error", requestId: sent[0]?.requestId ?? "", code, message: "Message du cerveau." });
    expect(store.notice).toBe("Message du cerveau.");
    expect(store.busy).toBe(false);
    expect(store.mascot).toBe(mascot);
  });

  test("connection lost mid-turn ends the turn with a notice", () => {
    const { store } = setup();
    store.send("Salut");
    store.connectionLost();
    expect(store.busy).toBe(false);
    expect(store.notice).toBe("Connexion perdue : la réponse d'Alicia n'est pas arrivée.");
    expect(store.mascot).toBe("alert");
  });

  test("open loads the history; startNew clears it", async () => {
    const { store } = setup([
      { id: "a", role: "user", text: "Salut", createdAt: "2026-10-04T13:30:00.000Z" },
      { id: "b", role: "assistant", text: "Coucou !", createdAt: "2026-10-04T13:30:01.000Z" },
    ]);
    await store.open(CONV);
    expect(store.activeId).toBe(CONV);
    expect(store.messages.map((m) => m.text)).toEqual(["Salut", "Coucou !"]);
    store.startNew();
    expect(store.activeId).toBeNull();
    expect(store.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run: `pnpm --filter @alicia/desktop test`
Expected: FAIL.

- [ ] **Step 3: Écrire l'état du chat**

`apps/desktop/src/renderer/src/lib/chat-store.svelte.ts` :
```ts
import type { ConversationSummary, HistoryMessage, SendMessage, ServerEvent } from "@alicia/protocol";
import type { MascotState } from "./mascot.ts";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
}

/** Everything the store needs from the outside world (fakes in tests). */
export interface ChatPorts {
  listConversations(): Promise<ConversationSummary[]>;
  history(conversationId: string): Promise<HistoryMessage[]>;
  send(message: SendMessage): boolean;
  newId(): string;
  schedule(run: () => void, ms: number): () => void;
}

const SUCCESS_MS = 1500;
const ALERT_MS = 2000;
const MASCOT_ON_ERROR: Readonly<Record<string, MascotState>> = {
  quota: "sleeping",
  busy: "alert",
  engine: "error",
  internal: "error",
};

export class ChatStore {
  conversations = $state<ConversationSummary[]>([]);
  activeId = $state<string | null>(null);
  messages = $state<ChatMessage[]>([]);
  busy = $state(false);
  opus = $state(false);
  activity = $state<string | null>(null);
  notice = $state<string | null>(null);
  mascot = $state<MascotState>("idle");

  readonly #ports: ChatPorts;
  #pendingRequestId: string | null = null;
  #cancelMascotReset: (() => void) | null = null;

  constructor(ports: ChatPorts) {
    this.#ports = ports;
  }

  async refreshConversations(): Promise<void> {
    try {
      this.conversations = await this.#ports.listConversations();
    } catch {
      // Keep the current list; the connection status already tells the user what is wrong.
    }
  }

  async open(conversationId: string): Promise<void> {
    if (this.busy) return;
    this.activeId = conversationId;
    this.notice = null;
    this.#setMascot("idle");
    try {
      const history = await this.#ports.history(conversationId);
      if (this.activeId !== conversationId) return;
      this.messages = history.map((m) => ({ id: m.id, role: m.role, text: m.text, streaming: false }));
    } catch {
      this.notice = "Impossible de charger cette conversation.";
    }
  }

  startNew(): void {
    if (this.busy) return;
    this.activeId = null;
    this.messages = [];
    this.notice = null;
    this.#setMascot("idle");
  }

  send(text: string): boolean {
    if (text.trim() === "" || this.busy) return false;
    const requestId = this.#ports.newId();
    const message: SendMessage = {
      type: "send",
      requestId,
      text,
      ...(this.activeId !== null ? { conversationId: this.activeId } : {}),
      ...(this.opus ? { model: "opus" as const } : {}),
    };
    if (!this.#ports.send(message)) {
      this.notice = "Alicia n'est pas joignable pour l'instant.";
      return false;
    }
    this.#pendingRequestId = requestId;
    this.busy = true;
    this.notice = null;
    this.activity = null;
    this.messages.push({ id: this.#ports.newId(), role: "user", text, streaming: false });
    this.#setMascot("thinking");
    return true;
  }

  handle(event: ServerEvent): void {
    switch (event.type) {
      case "ready":
        return;
      case "conversation":
        if (event.requestId !== this.#pendingRequestId) return;
        if (this.activeId === null) this.activeId = event.conversationId;
        void this.refreshConversations();
        return;
      case "text_delta": {
        this.activity = null;
        const last = this.messages.at(-1);
        if (last?.role === "assistant" && last.streaming) last.text += event.text;
        else this.messages.push({ id: this.#ports.newId(), role: "assistant", text: event.text, streaming: true });
        this.#setMascot("speaking");
        return;
      }
      case "tool_call":
        this.activity = `Alicia utilise l'outil « ${event.tool} »…`;
        this.#setMascot("thinking");
        return;
      case "tool_result":
        return;
      case "done":
        this.#endTurn();
        this.#setMascot("success", SUCCESS_MS);
        void this.refreshConversations();
        return;
      case "error":
        if (event.requestId !== undefined && event.requestId !== this.#pendingRequestId) return;
        this.#endTurn();
        this.notice = event.message;
        this.#setMascot(MASCOT_ON_ERROR[event.code] ?? "alert", event.code === "busy" ? ALERT_MS : undefined);
        return;
    }
  }

  connectionLost(): void {
    if (!this.busy) return;
    this.#endTurn();
    this.notice = "Connexion perdue : la réponse d'Alicia n'est pas arrivée.";
    this.#setMascot("alert");
  }

  #endTurn(): void {
    const last = this.messages.at(-1);
    if (last?.role === "assistant") last.streaming = false;
    this.busy = false;
    this.activity = null;
    this.#pendingRequestId = null;
  }

  /** Sets the mascot; with `resetAfterMs`, goes back to idle afterwards. */
  #setMascot(state: MascotState, resetAfterMs?: number): void {
    this.#cancelMascotReset?.();
    this.#cancelMascotReset = null;
    this.mascot = state;
    if (resetAfterMs !== undefined) {
      this.#cancelMascotReset = this.#ports.schedule(() => {
        this.mascot = "idle";
      }, resetAfterMs);
    }
  }
}
```

- [ ] **Step 4: Lancer les tests, puis commiter**

Run: `pnpm --filter @alicia/desktop test && pnpm typecheck && pnpm lint`
Expected: PASS. Si `svelte-check` ou ESLint signale l'accès `MASCOT_ON_ERROR[event.code]` comme toujours défini, typer la table en `Partial<Record<ErrorCode, MascotState>>` (import de `ErrorCode` depuis `@alicia/protocol`) plutôt que de désactiver la règle.
```bash
git add apps/desktop/src/renderer/src/lib/chat-store.svelte.ts apps/desktop/test/chat-store.test.ts
git commit -m "feat(desktop): chat state with streaming, errors and mascot moods

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Écran d'appairage et aiguillage

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/mascot-images.ts`, `apps/desktop/src/renderer/src/components/Mascot.svelte`, `apps/desktop/src/renderer/src/components/PairingScreen.svelte`
- Modify: `apps/desktop/src/renderer/src/App.svelte`

- [ ] **Step 1: Images et composant mascotte**

`apps/desktop/src/renderer/src/lib/mascot-images.ts` :
```ts
import alertUrl from "../assets/mascot/alert.webp";
import errorUrl from "../assets/mascot/error.webp";
import ideaUrl from "../assets/mascot/idea.webp";
import idleUrl from "../assets/mascot/idle.webp";
import listeningUrl from "../assets/mascot/listening.webp";
import sleepingUrl from "../assets/mascot/sleeping.webp";
import speakingUrl from "../assets/mascot/speaking.webp";
import successUrl from "../assets/mascot/success.webp";
import thinkingUrl from "../assets/mascot/thinking.webp";
import type { MascotState } from "./mascot.ts";

export const MASCOT_IMAGES: Readonly<Record<MascotState, string>> = {
  idle: idleUrl,
  sleeping: sleepingUrl,
  listening: listeningUrl,
  thinking: thinkingUrl,
  speaking: speakingUrl,
  success: successUrl,
  alert: alertUrl,
  error: errorUrl,
  idea: ideaUrl,
};
```

`apps/desktop/src/renderer/src/components/Mascot.svelte` :
```svelte
<script lang="ts">
  import { MASCOT_IMAGES } from "../lib/mascot-images.ts";
  import { MASCOT_STATES, type MascotState } from "../lib/mascot.ts";

  let { mood, size = 128 }: { mood: MascotState; size?: number } = $props();
</script>

<!-- Every pose is stacked; only the current one is opaque, so mood changes cross-fade. -->
<div class="mascot" style:width="{size}px" style:height="{size}px" role="img" aria-label="Alicia" data-testid="mascot" data-mood={mood}>
  {#each MASCOT_STATES as state (state)}
    <img src={MASCOT_IMAGES[state]} alt="" draggable="false" class:visible={state === mood} />
  {/each}
</div>

<style>
  .mascot { position: relative; flex: none; }
  img {
    position: absolute; inset: 0; width: 100%; height: 100%;
    opacity: 0; transition: opacity 220ms ease;
  }
  img.visible { opacity: 1; }
</style>
```

- [ ] **Step 2: Écran d'appairage**

`apps/desktop/src/renderer/src/components/PairingScreen.svelte` :
```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import type { StoredSession } from "../../../shared/session.ts";
  import { pair, type PairingFailure } from "../lib/brain-client.ts";
  import Mascot from "./Mascot.svelte";

  let { notice, onPaired }: { notice: string | null; onPaired: (session: StoredSession) => void } = $props();

  const MESSAGES: Readonly<Record<PairingFailure, string>> = {
    invalid_code: "Code invalide ou expiré. Demande-en un nouveau.",
    too_many_attempts: "Trop d'essais : réessaie dans une minute.",
    invalid_request: "Vérifie le code (6 chiffres) et le nom de l'appareil.",
    unreachable: "Impossible de joindre Alicia à cette adresse.",
  };

  let serverUrl = $state("http://127.0.0.1:8780");
  let code = $state("");
  let deviceName = $state("");
  let error = $state<string | null>(null);
  let pending = $state(false);

  onMount(() => {
    void window.alicia.deviceName().then((name) => {
      if (deviceName === "") deviceName = name;
    });
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    pending = true;
    error = null;
    const result = await pair(fetch.bind(window), serverUrl, code.trim(), deviceName.trim());
    if (result.ok) {
      await window.alicia.saveSession(result.session);
      onPaired(result.session);
    } else {
      error = MESSAGES[result.reason];
    }
    pending = false;
  }
</script>

<div class="screen" in:fade={{ duration: 200 }}>
  <div class="drag"></div>
  <form class="card" onsubmit={submit}>
    <Mascot mood={error === null ? "listening" : "alert"} size={160} />
    <h1>Bonjour, je suis Alicia</h1>
    <p class="lead">Pour faire connaissance, demande un code d'appairage au cerveau (commande <code>pair</code>).</p>
    {#if notice}<p class="notice" data-testid="pairing-notice">{notice}</p>{/if}
    <label>Adresse d'Alicia<input bind:value={serverUrl} data-testid="pairing-server" autocomplete="off" /></label>
    <label>Code à 6 chiffres<input bind:value={code} inputmode="numeric" maxlength="6" data-testid="pairing-code" autocomplete="off" /></label>
    <label>Nom de cet appareil<input bind:value={deviceName} maxlength="60" data-testid="pairing-device" /></label>
    {#if error}<p class="error" role="alert" data-testid="pairing-error" transition:fade={{ duration: 150 }}>{error}</p>{/if}
    <button type="submit" disabled={pending || code.trim().length !== 6} data-testid="pairing-submit">
      {pending ? "Connexion…" : "Appairer"}
    </button>
  </form>
</div>

<style>
  .screen { height: 100%; display: grid; place-items: center; position: relative; }
  .drag { position: absolute; inset: 0 0 auto 0; height: var(--titlebar-height); -webkit-app-region: drag; }
  .card {
    width: min(420px, 90vw); display: flex; flex-direction: column; align-items: center; gap: 12px;
    background: var(--night-deep); border: 1px solid var(--surface); border-radius: 18px; padding: 28px;
  }
  h1 { margin: 4px 0 0; font-size: 22px; }
  .lead { margin: 0 0 8px; color: var(--cream-muted); text-align: center; font-size: 14px; }
  code { color: var(--sage); }
  label { width: 100%; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--cream-muted); }
  input {
    background: var(--surface); border: 1px solid transparent; border-radius: 8px; padding: 9px 11px;
    transition: border-color var(--duration) ease;
  }
  input:focus { outline: none; border-color: var(--sage); }
  button {
    margin-top: 6px; width: 100%; padding: 10px; border: 0; border-radius: 10px; cursor: pointer;
    background: var(--sage); color: var(--night); font-weight: 700; transition: opacity var(--duration) ease;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .error { margin: 0; color: var(--amber); font-size: 14px; }
  .notice { margin: 0; color: var(--amber); font-size: 14px; text-align: center; }
</style>
```

- [ ] **Step 3: Aiguillage dans App**

`apps/desktop/src/renderer/src/App.svelte` (remplacement complet ; `Shell` est créé à la tâche 8 — créer d'abord un `Shell.svelte` provisoire qui affiche `<p>Connecté en tant que {session.person.name}</p>` avec les mêmes props, remplacé à la tâche 8) :
```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import type { StoredSession } from "../../shared/session.ts";
  import PairingScreen from "./components/PairingScreen.svelte";
  import Shell from "./components/Shell.svelte";

  let session = $state<StoredSession | null>(null);
  let loaded = $state(false);
  let notice = $state<string | null>(null);

  onMount(() => {
    void window.alicia.getSession().then((stored) => {
      session = stored;
      loaded = true;
    });
  });

  async function signOut(message: string | null): Promise<void> {
    await window.alicia.clearSession();
    session = null;
    notice = message;
  }
</script>

{#if loaded}
  {#if session}
    {#key session.token}
      <Shell {session} onSignOut={(message) => void signOut(message)} />
    {/key}
  {:else}
    <PairingScreen {notice} onPaired={(paired) => { session = paired; notice = null; }} />
  {/if}
{/if}
```

Provisoire `apps/desktop/src/renderer/src/components/Shell.svelte` :
```svelte
<script lang="ts">
  import type { StoredSession } from "../../../shared/session.ts";
  let { session }: { session: StoredSession; onSignOut: (message: string | null) => void } = $props();
</script>

<p>Connecté en tant que {session.person.name}</p>
```

- [ ] **Step 4: Vérifier à la main, puis commiter**

Run: `pnpm --filter @alicia/desktop build && pnpm test && pnpm typecheck && pnpm lint` → au vert.
Démarrer un cerveau de test : dans un terminal `cd apps/brain && pnpm exec tsx --env-file=.env src/cli.ts start` ; dans un autre `pnpm exec tsx src/cli.ts pair kevin` (depuis `apps/brain`). Lancer `pnpm --filter @alicia/desktop dev`, saisir le code : l'écran passe à « Connecté en tant que Kévin ». Fermer et relancer l'app : elle doit aller directement à cet écran (session conservée).
```bash
git add apps/desktop/src/renderer
git commit -m "feat(desktop): pairing screen, session routing and mascot component

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: La fenêtre principale

**Files:**
- Create: `apps/desktop/src/renderer/src/components/TitleBar.svelte`, `Sidebar.svelte`, `ChatView.svelte`, `Composer.svelte`
- Modify: `apps/desktop/src/renderer/src/components/Shell.svelte` (remplacement complet)

- [ ] **Step 1: Barre du haut**

`apps/desktop/src/renderer/src/components/TitleBar.svelte` :
```svelte
<script lang="ts">
  import type { ConnectionStatus } from "../lib/chat-connection.ts";

  let { title, personName, status, onToggleSidebar }: {
    title: string;
    personName: string;
    status: ConnectionStatus;
    onToggleSidebar: () => void;
  } = $props();

  const STATUS_LABEL: Readonly<Record<ConnectionStatus, string>> = {
    connecting: "Connexion…",
    ready: "",
    offline: "Hors ligne, reconnexion…",
    rejected: "Appareil refusé",
  };
</script>

<header class="titlebar">
  <button class="icon" onclick={onToggleSidebar} title="Afficher ou masquer le menu" aria-label="Menu">☰</button>
  <div class="segment" role="tablist">
    <button class="on" role="tab" aria-selected="true">💬 Chat</button>
    <button role="tab" aria-selected="false" disabled title="Bientôt">🏠 Maison</button>
  </div>
  <span class="title" data-testid="titlebar-title">{title}</span>
  <span class="person">{personName}</span>
  {#if STATUS_LABEL[status] !== ""}<span class="status" data-testid="connection-status">{STATUS_LABEL[status]}</span>{/if}
  <span class="spacer"></span>
</header>

<style>
  .titlebar {
    height: var(--titlebar-height); flex: none; display: flex; align-items: center; gap: 10px;
    padding: 0 150px 0 10px; /* right: Windows caption buttons overlay */
    background: var(--night-deep); border-bottom: 1px solid var(--surface); color: var(--cream-muted);
    -webkit-app-region: drag; user-select: none;
  }
  button { -webkit-app-region: no-drag; }
  .icon { background: none; border: 0; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
  .icon:hover { background: var(--surface); }
  .segment { display: flex; background: var(--surface); border-radius: 8px; padding: 2px; }
  .segment button { background: none; border: 0; padding: 3px 10px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .segment button.on { background: var(--surface-raised); color: var(--cream); }
  .segment button:disabled { opacity: 0.5; cursor: default; }
  .title { color: var(--cream); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .person { background: var(--surface); border-radius: 6px; padding: 2px 8px; font-size: 12px; }
  .status { color: var(--amber); font-size: 12px; }
  .spacer { flex: 1; }
</style>
```

- [ ] **Step 2: Menu latéral**

`apps/desktop/src/renderer/src/components/Sidebar.svelte` :
```svelte
<script lang="ts">
  import { fly } from "svelte/transition";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";

  let { store, personName, onSignOut }: {
    store: ChatStore;
    personName: string;
    onSignOut: () => void;
  } = $props();

  function signOut(): void {
    if (window.confirm(`Déconnecter cet appareil d'Alicia ? Il faudra l'appairer à nouveau.`)) onSignOut();
  }
</script>

<nav class="sidebar" transition:fly={{ x: -24, duration: 180 }}>
  <button class="new" onclick={() => { store.startNew(); }} disabled={store.busy} data-testid="new-conversation">
    ✦ Nouvelle conversation
  </button>
  <p class="label">Conversations</p>
  <ul data-testid="conversation-list">
    {#each store.conversations as conversation (conversation.id)}
      <li>
        <button
          class:active={conversation.id === store.activeId}
          onclick={() => void store.open(conversation.id)}
          disabled={store.busy}
          title={conversation.title}
        >{conversation.title}</button>
      </li>
    {:else}
      <li class="empty">Aucune conversation pour l'instant.</li>
    {/each}
  </ul>
  <footer>
    <span>{personName}</span>
    <button class="link" onclick={signOut}>Déconnecter</button>
  </footer>
</nav>

<style>
  .sidebar {
    width: 240px; flex: none; display: flex; flex-direction: column; gap: 4px; padding: 12px 8px;
    background: var(--night-deep); border-right: 1px solid var(--surface);
  }
  button { background: none; border: 0; text-align: left; cursor: pointer; border-radius: 8px; transition: background var(--duration) ease; }
  button:disabled { cursor: default; opacity: 0.6; }
  .new { padding: 8px 10px; font-weight: 700; color: var(--sage); }
  .new:hover:not(:disabled) { background: var(--surface); }
  .label { margin: 12px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
  li button {
    width: 100%; padding: 7px 10px; color: var(--cream-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  li button:hover:not(:disabled) { background: var(--surface); }
  li button.active { background: var(--surface); color: var(--cream); font-weight: 700; }
  .empty { padding: 7px 10px; color: var(--muted); font-size: 13px; }
  footer { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px 0; font-size: 13px; color: var(--cream-muted); }
  .link { color: var(--muted); font-size: 12px; padding: 2px 4px; }
  .link:hover { color: var(--amber); }
</style>
```

- [ ] **Step 3: Zone de conversation**

`apps/desktop/src/renderer/src/components/ChatView.svelte` :
```svelte
<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";
  import Mascot from "./Mascot.svelte";

  let { store, personName }: { store: ChatStore; personName: string } = $props();

  const SUGGESTIONS = [
    "Raconte-moi une anecdote surprenante",
    "Aide-moi à formuler un message gentil",
    "Réfléchis bien : une idée de sortie ce week-end ?",
  ];

  const greeting = (): string => {
    const hour = new Date().getHours();
    return hour >= 5 && hour < 18 ? "Bonjour" : "Bonsoir";
  };

  let list = $state<HTMLDivElement | null>(null);
  const lastAssistantId = $derived(store.messages.findLast((m) => m.role === "assistant")?.id);
  const waiting = $derived(store.busy && store.messages.at(-1)?.role === "user");

  // Follow the conversation as text streams in.
  $effect(() => {
    void store.messages.length;
    void store.messages.at(-1)?.text;
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  });
</script>

<section class="chat">
  {#if store.messages.length === 0}
    <div class="welcome" in:fade={{ duration: 200 }}>
      <Mascot mood={store.mascot} size={180} />
      <h1>{greeting()} {personName}, on fait quoi ?</h1>
      <div class="suggestions">
        {#each SUGGESTIONS as suggestion (suggestion)}
          <button onclick={() => { store.send(suggestion); }} disabled={store.busy}>{suggestion}</button>
        {/each}
      </div>
    </div>
  {:else}
    <div class="messages" bind:this={list} data-testid="messages">
      {#each store.messages as message (message.id)}
        <div class="row {message.role}" in:fly={{ y: 8, duration: 180 }}>
          {#if message.role === "assistant"}
            <div class="avatar">
              {#if message.id === lastAssistantId}<Mascot mood={store.mascot} size={44} />{/if}
            </div>
          {/if}
          <div class="bubble" data-testid="message-{message.role}">
            {message.text}{#if message.streaming}<span class="caret"></span>{/if}
          </div>
        </div>
      {/each}
      {#if waiting}
        <div class="row assistant" in:fade={{ duration: 150 }}>
          <div class="avatar"><Mascot mood={store.mascot} size={44} /></div>
          <div class="bubble typing" aria-label="Alicia réfléchit"><span></span><span></span><span></span></div>
        </div>
      {/if}
      {#if store.activity}<p class="activity" transition:fade={{ duration: 150 }}>{store.activity}</p>{/if}
    </div>
  {/if}
  {#if store.notice}
    <p class="notice" role="status" data-testid="notice" transition:fade={{ duration: 150 }}>{store.notice}</p>
  {/if}
</section>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; }
  h1 { margin: 0; font-size: 24px; text-align: center; }
  .suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 640px; }
  .suggestions button {
    background: none; border: 1px solid var(--surface-raised); border-radius: 16px; padding: 6px 12px;
    color: var(--cream-muted); cursor: pointer; transition: border-color var(--duration) ease, color var(--duration) ease;
  }
  .suggestions button:hover:not(:disabled) { border-color: var(--sage); color: var(--cream); }
  .messages { flex: 1; overflow-y: auto; padding: 20px max(24px, calc((100% - 760px) / 2)); display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  .row.user { justify-content: flex-end; }
  .avatar { width: 44px; flex: none; }
  .bubble { max-width: 72%; padding: 9px 13px; border-radius: 14px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .user .bubble { background: var(--surface-raised); border-bottom-right-radius: 4px; }
  .assistant .bubble { background: var(--surface); border-bottom-left-radius: 4px; }
  .caret { display: inline-block; width: 7px; height: 1em; margin-left: 2px; vertical-align: -2px; background: var(--sage); animation: blink 1s steps(2) infinite; }
  .typing { display: flex; gap: 4px; padding: 14px 16px; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--cream-muted); animation: bounce 1.2s ease-in-out infinite; }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }
  .activity { margin: 0 0 0 52px; font-size: 13px; color: var(--muted); font-style: italic; }
  .notice { margin: 0 auto 8px; padding: 6px 12px; border-radius: 8px; background: var(--night-deep); color: var(--amber); font-size: 14px; }
  @keyframes blink { 50% { opacity: 0; } }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }
</style>
```

- [ ] **Step 4: Zone de saisie**

`apps/desktop/src/renderer/src/components/Composer.svelte` :
```svelte
<script lang="ts">
  import type { ConnectionStatus } from "../lib/chat-connection.ts";
  import type { ChatStore } from "../lib/chat-store.svelte.ts";

  let { store, status }: { store: ChatStore; status: ConnectionStatus } = $props();
  let text = $state("");
  const ready = $derived(status === "ready");

  function submit(): void {
    if (store.send(text)) text = "";
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }
</script>

<form class="composer" onsubmit={(event) => { event.preventDefault(); submit(); }}>
  <textarea
    bind:value={text}
    onkeydown={onKeydown}
    rows="1"
    placeholder={ready ? "Demande à Alicia…" : "Connexion à Alicia…"}
    disabled={!ready}
    data-testid="composer-input"
  ></textarea>
  <button
    type="button"
    class="opus"
    class:on={store.opus}
    aria-pressed={store.opus}
    title="Réfléchir plus longtemps (Opus)"
    onclick={() => { store.opus = !store.opus; }}
  >Opus</button>
  <button type="submit" class="send" disabled={!ready || store.busy || text.trim() === ""} data-testid="composer-send">
    Envoyer
  </button>
</form>

<style>
  .composer {
    margin: 0 max(24px, calc((100% - 760px) / 2)) 18px; display: flex; align-items: flex-end; gap: 8px;
    background: var(--surface); border-radius: 14px; padding: 8px;
  }
  textarea {
    flex: 1; resize: none; border: 0; background: none; padding: 6px 8px; line-height: 1.45;
    field-sizing: content; max-height: 200px; outline: none;
  }
  button { border: 0; border-radius: 9px; padding: 7px 12px; cursor: pointer; transition: background var(--duration) ease, color var(--duration) ease, opacity var(--duration) ease; }
  .opus { background: none; color: var(--muted); font-size: 13px; }
  .opus.on { background: var(--surface-raised); color: var(--amber); font-weight: 700; }
  .send { background: var(--sage); color: var(--night); font-weight: 700; }
  .send:disabled { opacity: 0.45; cursor: default; }
</style>
```

- [ ] **Step 5: Assemblage de la fenêtre**

`apps/desktop/src/renderer/src/components/Shell.svelte` (remplacement complet) :
```svelte
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { StoredSession } from "../../../shared/session.ts";
  import { BrainApi, UnauthorizedError, webSocketUrl } from "../lib/brain-client.ts";
  import { browserSocket, ChatConnection, type ConnectionStatus } from "../lib/chat-connection.ts";
  import { ChatStore } from "../lib/chat-store.svelte.ts";
  import ChatView from "./ChatView.svelte";
  import Composer from "./Composer.svelte";
  import Sidebar from "./Sidebar.svelte";
  import TitleBar from "./TitleBar.svelte";

  let { session, onSignOut }: { session: StoredSession; onSignOut: (message: string | null) => void } = $props();

  const REVOKED = "Cet appareil a été déconnecté d'Alicia. Appaire-le à nouveau.";
  const schedule = (run: () => void, ms: number): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => {
      clearTimeout(timer);
    };
  };

  // App.svelte re-creates this component when the session changes ({#key}), so reading props once is intended.
  const api = new BrainApi(fetch.bind(window), session);
  let status = $state<ConnectionStatus>("connecting");
  let sidebarOpen = $state(true);

  const connection = new ChatConnection({
    url: webSocketUrl(session.serverUrl),
    token: session.token,
    openSocket: browserSocket,
    schedule,
    onEvent: (event) => {
      store.handle(event);
    },
    onStatus: (next) => {
      status = next;
      if (next === "offline") store.connectionLost();
      if (next === "rejected") onSignOut(REVOKED);
    },
  });

  const store = new ChatStore({
    listConversations: async () => {
      try {
        return await api.listConversations();
      } catch (error) {
        if (error instanceof UnauthorizedError) onSignOut(REVOKED);
        throw error;
      }
    },
    history: (id) => api.history(id),
    send: (message) => connection.send(message),
    newId: () => crypto.randomUUID(),
    schedule,
  });

  const title = $derived(store.conversations.find((c) => c.id === store.activeId)?.title ?? "Nouvelle conversation");

  onMount(() => {
    connection.start();
    void store.refreshConversations();
  });
  onDestroy(() => {
    connection.stop();
  });
</script>

<div class="app">
  <TitleBar {title} personName={session.person.name} {status} onToggleSidebar={() => { sidebarOpen = !sidebarOpen; }} />
  <div class="body">
    {#if sidebarOpen}
      <Sidebar {store} personName={session.person.name} onSignOut={() => { onSignOut(null); }} />
    {/if}
    <main>
      <ChatView {store} personName={session.person.name} />
      <Composer {store} {status} />
    </main>
  </div>
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; }
  .body { flex: 1; min-height: 0; display: flex; }
  main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--night); }
</style>
```

- [ ] **Step 6: Vérifier à la main, puis commiter**

Run: `pnpm --filter @alicia/desktop build && pnpm test && pnpm typecheck && pnpm lint` → au vert.
Avec le cerveau réel démarré (tâche 7, step 4), lancer `pnpm --filter @alicia/desktop dev` :
- l'accueil affiche la mascotte et « Bonjour/Bonsoir Kévin, on fait quoi ? » ;
- envoyer « Bonjour » : la mascotte passe en réflexion, les trois points s'animent, puis le texte s'écrit et la mascotte parle, puis fait « victoire » et revient au repos ;
- la conversation apparaît dans le menu ; « Nouvelle conversation » vide la zone ; cliquer l'ancienne recharge l'historique ;
- arrêter le cerveau : la barre affiche « Hors ligne, reconnexion… », puis revient seule au redémarrage du cerveau.
```bash
git add apps/desktop/src/renderer/src/components
git commit -m "feat(desktop): main window with title bar, conversation sidebar, live chat and composer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Test de bout en bout

**Files:**
- Create: `apps/desktop/vitest.e2e.config.ts`, `apps/desktop/e2e/app.e2e.ts`

Le test démarre un **vrai cerveau** (base temporaire, `FakeEngine`), lance l'app Electron construite avec un profil temporaire, et la pilote par Playwright (jamais de clics souris système).

- [ ] **Step 1: Configuration**

`apps/desktop/vitest.e2e.config.ts` :
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 90_000, hookTimeout: 90_000, fileParallelism: false },
});
```

- [ ] **Step 2: Écrire le test**

`apps/desktop/e2e/app.e2e.ts` :
```ts
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Application, buildApplication } from "../../brain/src/application.ts";
import { parseConfig } from "../../brain/src/config.ts";
import { FakeEngine } from "../../brain/src/engine/fake-engine.ts";

const MAIN = fileURLToPath(new URL("../out/main/index.js", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "alicia-e2e-brain-"));
const userData = mkdtempSync(join(tmpdir(), "alicia-e2e-profile-"));
let brain: Application;
let serverUrl: string;

beforeAll(async () => {
  const config = parseConfig(`
dataDir: ${JSON.stringify(dataDir)}
people: [{ id: kevin, name: Kévin }]
engine: { mode: subscription }
`);
  const engine = new FakeEngine(() => [
    { type: "session", sessionId: "s1" },
    { type: "text", text: "Bonjour Kévin, " },
    { type: "text", text: "je suis là !" },
    { type: "done", inputTokens: 1, outputTokens: 2 },
  ]);
  brain = await buildApplication(config, engine);
  await brain.server.listen({ port: 0, host: "127.0.0.1" });
  serverUrl = `http://127.0.0.1:${(brain.server.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await brain.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [MAIN], env: { ...process.env, ALICIA_USER_DATA: userData } });
  return { app, page: await app.firstWindow() };
}

test("pair, chat with streaming, then find the conversation again after a restart", async () => {
  const first = await launch();
  const { page } = first;
  await page.getByTestId("pairing-server").fill(serverUrl);
  await page.getByTestId("pairing-code").fill(brain.pairing.generateCode("kevin"));
  await page.getByTestId("pairing-submit").click();

  await page.getByText("Kévin, on fait quoi ?").waitFor();
  await page.getByTestId("composer-input").fill("Salut Alicia");
  await page.getByTestId("composer-input").press("Enter");
  await page.getByTestId("message-assistant").filter({ hasText: "Bonjour Kévin, je suis là !" }).waitFor();
  await page.getByTestId("conversation-list").getByText("Salut Alicia").waitFor();
  expect(await page.getByTestId("mascot").first().getAttribute("data-mood")).toMatch(/success|idle/);
  await first.app.close();

  // Session survives a restart: straight to the chat, history reloadable.
  const second = await launch();
  await second.page.getByTestId("conversation-list").getByText("Salut Alicia").click();
  await second.page.getByTestId("message-user").filter({ hasText: "Salut Alicia" }).waitFor();
  await second.page.getByTestId("message-assistant").filter({ hasText: "je suis là !" }).waitFor();
  await second.app.close();
});

test("a wrong pairing code is explained", async () => {
  const freshProfile = mkdtempSync(join(tmpdir(), "alicia-e2e-profile-"));
  const app = await electron.launch({ args: [MAIN], env: { ...process.env, ALICIA_USER_DATA: freshProfile } });
  const page = await app.firstWindow();
  await page.getByTestId("pairing-server").fill(serverUrl);
  await page.getByTestId("pairing-code").fill("000000");
  await page.getByTestId("pairing-submit").click();
  await page.getByTestId("pairing-error").filter({ hasText: "Code invalide" }).waitFor();
  await app.close();
  rmSync(freshProfile, { recursive: true, force: true });
});
```

Vérifier les noms réels du cerveau avant d'écrire (`buildApplication`, `Application.pairing.generateCode`, `parseConfig`, `FakeEngine`, événements `text`/`done` de l'`EngineEvent`) dans `apps/brain/src/` ; aligner le test si un nom diffère.

- [ ] **Step 3: Lancer**

Run: `pnpm --filter @alicia/desktop test:e2e`
Expected: 2 tests PASS. Si Playwright n'arrive pas à lancer Electron (version de Chromium), installer les binaires requis selon son message d'erreur, puis relancer. Si la deuxième fenêtre n'affiche pas directement le chat, c'est que la session n'a pas été conservée : c'est un vrai bug à corriger, pas le test.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/vitest.e2e.config.ts apps/desktop/e2e
git commit -m "test(desktop): end-to-end pairing and chat against a real brain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Section « App de bureau »**

Ajouter au `README.md`, après la section du cerveau :
````markdown
## App de bureau (Windows)

```bash
pnpm --filter @alicia/desktop dev        # lance l'app en développement
pnpm --filter @alicia/desktop test       # tests unitaires
pnpm --filter @alicia/desktop test:e2e   # bout en bout (construit l'app, lance un cerveau de test)
pnpm --filter @alicia/desktop mascot     # régénère les images de la mascotte depuis design/
```
Premier lancement : saisir l'adresse du cerveau (par défaut `http://127.0.0.1:8780`) et un code
obtenu avec `pnpm exec tsx src/cli.ts pair <personne>` (depuis `apps/brain`). La session est
chiffrée par Windows (DPAPI, via `safeStorage`) dans le profil de l'utilisateur.
````

- [ ] **Step 2: Vérification finale et commit**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @alicia/desktop test:e2e`
Expected: tout au vert.
```bash
git add README.md
git commit -m "docs: desktop app usage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Couverture de la spec par ce plan

| Exigence (spec, section App Electron) | Tâche |
|---|---|
| Sécurité Electron (`contextIsolation`, `sandbox`, pas de `nodeIntegration`, pont minimal validé) | 2, 3 |
| Barre du haut intégrée + boutons natifs Windows (`titleBarOverlay`), bascule Chat \| Maison | 2, 8 |
| Menu à gauche, chat au centre (maquette v2) | 8 |
| Chat : réponse en direct, ligne d'activité, bouton Opus, liste des conversations | 5, 6, 8 |
| Premier lancement : saisie de l'adresse puis code d'appairage | 4, 7 |
| Jeton stocké chiffré côté client (`safeStorage`) | 3 |
| Palette Forêt de nuit, Nunito auto-hébergée, transitions fluides | 2, 7, 8 |
| Mascotte reflétant l'état d'Alicia (nouvelle mascotte validée) | 1, 2, 6, 7 |
| Appareil révoqué → retour à l'appairage avec explication | 5, 8 |
| Tests Playwright des parcours clés, sans souris système | 9 |

Reportés au plan 4b : Holo détaché, barre Spotlight, zone de notification, notifications Windows, installateur NSIS et mises à jour servies par le cerveau, découverte mDNS. Les cartes de confirmation et le glisser-déposer de fichiers arriveront avec le plan 3 (outils), l'écran Souvenirs avec le plan 2.
