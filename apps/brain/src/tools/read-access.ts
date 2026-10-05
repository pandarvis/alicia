import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const WINDOWS = process.platform === "win32";
/**
 * The only path form accepted on Windows: a drive letter, a colon, a separator, then no other colon. Refuses
 * device and long paths (\\?\…, \\.\…, \??\…), UNC shares (\\server\share), drive-relative (C:dossier) and
 * root-relative (\Windows) paths, and alternate data streams (file.pdf:secret, file.pdf::$DATA).
 */
const WINDOWS_PLAIN = /^[A-Za-z]:[\\/][^:]*$/u;

/** The path with links, junctions, `..` and 8.3 short names resolved; undefined if it does not exist. */
function canonical(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

const fold = (path: string): string => (WINDOWS ? path.toLowerCase() : path);

/** `child` strictly inside `root` (both canonical). */
function isInside(child: string, root: string): boolean {
  const rel = relative(fold(root), fold(child));
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/**
 * True when `path` names an existing regular file inside one of `roots`, once links, junctions and short names
 * are resolved (the comparison ignores case on Windows). Refused: relative paths, on Windows anything but a
 * plain drive path (see WINDOWS_PLAIN), and a file with several hard links (the brain never makes any: one would
 * be another file's second name). On a case-insensitive macOS volume, the case-sensitive comparison can only
 * refuse more, never less.
 */
export function isReadable(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  if (WINDOWS && !WINDOWS_PLAIN.test(path)) return false;
  const file = canonical(path);
  if (file === undefined) return false;
  try {
    const stats = statSync(file);
    if (!stats.isFile() || stats.nlink !== 1) return false;
  } catch {
    return false;
  }
  return roots.some((root) => {
    const dir = canonical(root);
    return dir !== undefined && isInside(file, dir);
  });
}
