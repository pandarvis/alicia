import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { isReadable } from "../src/tools/read-access.ts";
import { createTempDir } from "./helpers.ts";

const CONV = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WINDOWS = process.platform === "win32";

function layout() {
  const root = createTempDir();
  const conv = join(root, "attachments", CONV);
  const other = join(root, "attachments", OTHER);
  const sibling = `${conv}-evil`;
  for (const dir of [conv, other, sibling]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(conv, "facture-longue-du-mois.pdf"), "%PDF-1.7");
  writeFileSync(join(other, "secret.pdf"), "%PDF-1.7");
  writeFileSync(join(sibling, "x.pdf"), "%PDF-1.7");
  writeFileSync(join(root, "alicia.db"), "db");
  return { root, conv, other, sibling, file: join(conv, "facture-longue-du-mois.pdf") };
}

/** The 8.3 short form of a path (Windows), or undefined when the volume keeps no short names. */
function shortPath(path: string): string | undefined {
  const out = spawnSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${path}") do @echo %~sI`], {
    windowsVerbatimArguments: true, encoding: "utf8",
  }).stdout.trim();
  return out === path ? undefined : out;
}

describe("isReadable", () => {
  test("a file of the conversation's folder, also through a path that resolves inside it", () => {
    const { conv, file } = layout();
    expect(isReadable(file, [conv])).toBe(true);
    expect(isReadable(`${conv}${sep}..${sep}${CONV}${sep}facture-longue-du-mois.pdf`, [conv])).toBe(true);
  });

  test("everything else is refused: traversal, other folders, relative paths, folders, missing files", () => {
    const { conv, sibling } = layout();
    for (const path of [
      `${conv}${sep}..${sep}${OTHER}${sep}secret.pdf`,
      `${conv}${sep}..${sep}..${sep}alicia.db`,
      "facture-longue-du-mois.pdf",
      `.${sep}facture-longue-du-mois.pdf`,
      join(sibling, "x.pdf"),
      conv,
      join(conv, "absent.pdf"),
      "",
    ]) {
      expect(isReadable(path, [conv]), path).toBe(false);
    }
  });

  test("a junction (or link) inside the folder leading elsewhere is refused", () => {
    const { conv, other } = layout();
    symlinkSync(other, join(conv, "lien"), "junction");
    expect(isReadable(join(conv, "lien", "secret.pdf"), [conv])).toBe(false);
  });

  test("a file link to the outside is refused (when the system lets us create one)", (context) => {
    const { conv, root } = layout();
    try {
      symlinkSync(join(root, "alicia.db"), join(conv, "base.pdf"), "file");
    } catch {
      context.skip("file symbolic links need extra rights here");
    }
    expect(isReadable(join(conv, "base.pdf"), [conv])).toBe(false);
  });

  test("a hard link to a file elsewhere is refused (the brain never makes any)", () => {
    const { conv, root } = layout();
    linkSync(join(root, "alicia.db"), join(conv, "base.pdf"));
    expect(isReadable(join(conv, "base.pdf"), [conv])).toBe(false);
  });

  test("a root that does not exist reaches nothing", () => {
    const { conv, file } = layout();
    expect(isReadable(file, [join(conv, "absent")])).toBe(false);
    expect(isReadable(file, [])).toBe(false);
  });

  test.skipIf(!WINDOWS)("Windows: case does not matter", () => {
    const { conv, file } = layout();
    expect(isReadable(file.toUpperCase(), [conv])).toBe(true);
    expect(isReadable(file, [conv.toUpperCase()])).toBe(true);
  });

  test.skipIf(!WINDOWS)("Windows: alternate data streams, device, UNC and drive-relative paths are refused", () => {
    const { conv, file } = layout();
    for (const path of [
      `${file}:secret`,
      `${file}::$DATA`,
      `${file}:secret:$DATA`,
      `\\\\?\\${file}`,
      `\\\\.\\${file}`,
      `//?/${file}`,
      `\\\\?\\UNC\\localhost\\${file.replace(":", "$")}`,
      `\\\\localhost\\${file.replace(":", "$")}`,
      `\\??\\${file}`,
      file.slice(2),
      `${file.slice(0, 2)}${file.slice(3)}`,
      join(conv, "nul"),
      join(conv, "CON"),
    ]) {
      expect(isReadable(path, [conv]), path).toBe(false);
    }
  });

  test.skipIf(!WINDOWS)("Windows: 8.3 short names resolve to the real file, inside or not", (context) => {
    const { conv, file, sibling } = layout();
    const short = shortPath(file);
    if (short === undefined) context.skip("this volume keeps no 8.3 names");
    expect(isReadable(short ?? "", [conv])).toBe(true);
    // The sibling folder's short name (ALICIA~… / 11111~2) never passes for the conversation's folder.
    const outside = shortPath(join(sibling, "x.pdf"));
    expect(isReadable(outside ?? join(sibling, "x.pdf"), [conv])).toBe(false);
    const shortRoot = shortPath(conv);
    expect(isReadable(file, [shortRoot ?? conv])).toBe(true);
  });
});
