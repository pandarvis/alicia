import { EventEmitter } from "node:events";
import { isIPv4 } from "node:net";
import { Bonjour, type Service } from "bonjour-service";
import { z } from "zod";
import { DiscoveredBrain } from "../shared/discovery.ts";

/** The brain announces itself as `_alicia._tcp` (apps/brain/src/discovery.ts). */
export const SERVICE_TYPE = "alicia";
/**
 * bonjour-service never listens to its multicast-dns socket's `error` (port 5353 taken by another responder,
 * refused by the system…): without a listener, Node throws it in the main process (an error dialog). Reached
 * through its internals (`server.mdns`), checked at run time; false when the shape is not the expected one.
 */
export function guardSocketErrors(bonjour: unknown, onError: (error: unknown) => void): boolean {
  const server: unknown = typeof bonjour === "object" && bonjour !== null ? Reflect.get(bonjour, "server") : undefined;
  const mdns: unknown = typeof server === "object" && server !== null ? Reflect.get(server, "mdns") : undefined;
  if (!(mdns instanceof EventEmitter)) return false;
  mdns.on("error", onError);
  return true;
}

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
      // No mDNS on this network (port taken, refused…): the pairing screen falls back to the manual address.
      const unavailable = (error: unknown): void => {
        console.error("mDNS unavailable", error);
      };
      const bonjour = new Bonjour(undefined, unavailable);
      if (!guardSocketErrors(bonjour, unavailable)) console.error("mDNS: socket errors cannot be caught with this bonjour-service");
      const browser = bonjour.find({ type: SERVICE_TYPE });
      browser.on("up", (service: Service) => {
        const brain = brainFromService(service);
        if (brain !== null) onUp(brain);
      });
      browser.on("down", (service: Service) => {
        onDown(service.name);
      });
      // Same brain, new address or port: the old entry goes, the new one comes.
      browser.on("srv-update", (service: Service, previous: Service) => {
        onDown(previous.name);
        const brain = brainFromService(service);
        if (brain !== null) onUp(brain);
      });
      const timer = setInterval(() => {
        // Brains that stopped answering (their record's lifetime is over) leave the list.
        browser.expire();
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

/**
 * The brains found on the local network while the pairing screen looks for them, sorted by name, one entry per
 * brain (by name and by address). Looking pauses while the main window is hidden.
 */
export class BrainDiscovery {
  readonly #browser: BrainBrowser;
  readonly #onChange: (brains: DiscoveredBrain[]) => void;
  /** By address. */
  readonly #found = new Map<string, DiscoveredBrain>();
  /** The pairing screen asked to look. */
  #wanted = false;
  #visible = true;
  #stop: (() => void) | null = null;

  constructor(browser: BrainBrowser, onChange: (brains: DiscoveredBrain[]) => void) {
    this.#browser = browser;
    this.#onChange = onChange;
  }

  get brains(): DiscoveredBrain[] {
    return [...this.#found.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }

  start(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#found.clear();
    if (this.#visible) this.#run();
  }

  stop(): void {
    this.#wanted = false;
    this.#halt();
  }

  /** The main window (where the pairing screen lives) was shown or hidden. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (!this.#wanted) return;
    if (visible) this.#run();
    else this.#halt();
  }

  #run(): void {
    if (this.#stop !== null) return;
    this.#stop = this.#browser.start(
      (brain) => {
        for (const [url, known] of this.#found) {
          if (known.name === brain.name || url === brain.url) this.#found.delete(url);
        }
        this.#found.set(brain.url, brain);
        this.#onChange(this.brains);
      },
      (name) => {
        let removed = false;
        for (const [url, known] of this.#found) {
          if (known.name === name) removed = this.#found.delete(url) || removed;
        }
        if (removed) this.#onChange(this.brains);
      },
    );
  }

  #halt(): void {
    this.#stop?.();
    this.#stop = null;
  }
}
