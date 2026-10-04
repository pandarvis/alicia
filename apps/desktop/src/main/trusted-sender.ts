export interface TrustedSenderOptions {
  /** `file://` URL of the bundled renderer page (production). */
  rendererFileUrl: string;
  /** Dev server URL; set only when running unpackaged with electron-vite dev. */
  devUrl: string | undefined;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True when an IPC message comes from the page this app itself loads. */
export function isTrustedSenderUrl(url: string | undefined, options: TrustedSenderOptions): boolean {
  if (url === undefined || url === "") return false;
  const sender = parse(url);
  if (sender === null) return false;
  if (sender.protocol === "file:") {
    const renderer = parse(options.rendererFileUrl);
    return renderer !== null && sender.pathname.toLowerCase() === renderer.pathname.toLowerCase();
  }
  if (options.devUrl === undefined || options.devUrl === "") return false;
  const dev = parse(options.devUrl);
  return dev !== null && sender.origin === dev.origin;
}
