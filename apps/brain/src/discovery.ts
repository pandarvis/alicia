import { Bonjour } from "bonjour-service";
import type { Config } from "./config.ts";

/** Service type `_alicia._tcp`, browsed by the desktop app's pairing screen. */
export const SERVICE_TYPE = "alicia";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
/** Withdrawing the announcement never holds the brain's shutdown longer than this. */
const STOP_TIMEOUT_MS = 2000;

export interface ServiceAnnouncement {
  name: string;
  type: string;
  port: number;
  txt: Record<string, string>;
}

/** Publishes on the local network (bonjour-service in the brain, a fake in tests). */
export interface Publisher {
  publish(announcement: ServiceAnnouncement): void;
  stop(): Promise<void>;
}

export function bonjourPublisher(onError: (error: unknown) => void): Publisher {
  const bonjour = new Bonjour(undefined, onError);
  return {
    publish: (announcement) => {
      // A name conflict or a socket error must never bring the brain down.
      bonjour.publish({ ...announcement }).on("error", onError);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        bonjour.unpublishAll(() => {
          bonjour.destroy();
          resolve();
        });
      }),
  };
}

/** Only when enabled and listening beyond this machine (an announced loopback address would be useless). */
export function shouldAdvertise(config: Pick<Config, "discovery" | "host">): boolean {
  return config.discovery && !LOOPBACK.has(config.host);
}

/** Resolves when the withdrawal is done, failed, or takes too long: shutting down goes on regardless. */
function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

/** Announces « Alicia sur <machine> »; the TXT record carries the version. */
export function advertiseBrain(
  options: { port: number; version: string; hostname: string },
  publisher: Publisher,
): { stop(): Promise<void> } {
  publisher.publish({
    name: `Alicia sur ${options.hostname}`,
    type: SERVICE_TYPE,
    port: options.port,
    txt: { version: options.version },
  });
  return { stop: () => settleWithin(publisher.stop(), STOP_TIMEOUT_MS) };
}
