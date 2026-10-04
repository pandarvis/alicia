import { isIPv4 } from "node:net";
import { Bonjour, type Service } from "bonjour-service";
import { z } from "zod";
import { DiscoveredBrain } from "../shared/discovery.ts";

/** The brain announces itself as `_alicia._tcp` (apps/brain/src/discovery.ts). */
export const SERVICE_TYPE = "alicia";
/** Brains started after the search began answer the next query. */
const REQUERY_MS = 4000;
const Txt = z.object({ version: z.string().min(1).max(40) });

/** The parts of an mDNS answer we read (bonjour-service's Service). */
export interface ServiceLike {
  name: string;
  port: number;
  addresses?: string[] | undefined;
  referer?: { address: string; family: string } | undefined;
  txt?: unknown;
}

function usableIPv4(address: string): boolean {
  return isIPv4(address) && !address.startsWith("169.254.");
}

/** The brain an mDNS answer describes, or null when it cannot be reached over IPv4. */
export function brainFromService(service: ServiceLike): DiscoveredBrain | null {
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65_535) return null;
  const referer = service.referer?.family === "IPv4" ? service.referer.address : undefined;
  const address = [referer, ...(service.addresses ?? [])].find(
    (candidate): candidate is string => candidate !== undefined && usableIPv4(candidate),
  );
  if (address === undefined) return null;
  const txt = Txt.safeParse(service.txt);
  const brain = DiscoveredBrain.safeParse({
    name: service.name.slice(0, 80),
    url: `http://${address}:${service.port}`,
    version: txt.success ? txt.data.version : null,
  });
  return brain.success ? brain.data : null;
}

/** Something that finds brains; returns how to stop looking. */
export interface BrainBrowser {
  start(onUp: (brain: DiscoveredBrain) => void, onDown: (name: string) => void): () => void;
}

/**
 * Real mDNS, only while the pairing screen looks for a brain: it opens a UDP socket, which Windows' firewall
 * may ask about once.
 */
export function bonjourBrowser(): BrainBrowser {
  return {
    start(onUp, onDown) {
      const bonjour = new Bonjour(undefined, () => {
        // No network for mDNS: the pairing screen falls back to the manual address.
        console.error("mDNS unavailable");
      });
      const browser = bonjour.find({ type: SERVICE_TYPE });
      browser.on("up", (service: Service) => {
        const brain = brainFromService(service);
        if (brain !== null) onUp(brain);
      });
      browser.on("down", (service: Service) => {
        onDown(service.name);
      });
      const timer = setInterval(() => {
        browser.update();
      }, REQUERY_MS);
      return () => {
        clearInterval(timer);
        browser.stop();
        bonjour.destroy();
      };
    },
  };
}

/** For tests (ALICIA_TEST_BRAINS): a fixed list, announced at once. */
export function staticBrowser(brains: readonly DiscoveredBrain[]): BrainBrowser {
  return {
    start(onUp) {
      for (const brain of brains) onUp(brain);
      return () => undefined;
    },
  };
}

/** The brains found on the local network while the pairing screen looks for them, sorted by name. */
export class BrainDiscovery {
  readonly #browser: BrainBrowser;
  readonly #onChange: (brains: DiscoveredBrain[]) => void;
  readonly #found = new Map<string, DiscoveredBrain>();
  #stop: (() => void) | null = null;

  constructor(browser: BrainBrowser, onChange: (brains: DiscoveredBrain[]) => void) {
    this.#browser = browser;
    this.#onChange = onChange;
  }

  get brains(): DiscoveredBrain[] {
    return [...this.#found.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }

  start(): void {
    if (this.#stop !== null) return;
    this.#found.clear();
    this.#stop = this.#browser.start(
      (brain) => {
        this.#found.set(brain.name, brain);
        this.#onChange(this.brains);
      },
      (name) => {
        if (this.#found.delete(name)) this.#onChange(this.brains);
      },
    );
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }
}
