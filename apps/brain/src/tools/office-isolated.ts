import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { OfficeText } from "./office-text.ts";

/** What the worker may answer (checked: a worker is a boundary too). */
const Answer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("text"), text: z.string() }),
  z.object({ status: z.enum(["protected", "too_big", "unreadable"]) }),
]);

/** "cancelled": the turn ended while the document was being read (the worker is stopped). */
export type IsolatedOfficeText = OfficeText | { status: "too_slow" } | { status: "cancelled" };

export interface IsolationOptions {
  /** Past this, the worker is stopped and the document refused (default 30 s). */
  timeoutMs?: number;
  /** Heap of the worker (default 512 MB): a document needing more is refused, the brain keeps running. */
  heapMb?: number;
  /** The turn's signal: when it aborts, the worker is stopped at once and the reading given up. */
  signal?: AbortSignal;
  /** The worker's script (default: office-worker.ts); tests only. */
  entry?: URL;
}

const WORKER = new URL("./office-worker.ts", import.meta.url);
/** Node strips the worker's types itself when it can; otherwise (Node 22 under tsx or Vitest) it is asked to. */
const STRIP_TYPES = process.features.typescript === false
  ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]
  : [];

/** A worker error for the log: its name and code only, never its message (it may quote the document). */
function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? `${name} (${code})` : name;
}

/**
 * Reads a Word / Excel document in a worker thread with its own memory limit and a hard deadline: a document that
 * would take the brain's memory or time (a huge workbook) is refused, and the brain's event loop never blocks.
 * The worker lives no longer than the turn. Never throws.
 */
export function officeTextIsolated(bytes: Uint8Array, options: IsolationOptions = {}): Promise<IsolatedOfficeText> {
  const { signal } = options;
  if (signal?.aborted === true) return Promise.resolve({ status: "cancelled" });
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(options.entry ?? WORKER, {
      workerData: bytes,
      execArgv: STRIP_TYPES,
      resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? 512 },
    });
    const cancel = (): void => {
      settle({ status: "cancelled" });
    };
    const settle = (result: IsolatedOfficeText): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ status: "too_slow" });
    }, options.timeoutMs ?? 30_000);
    signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message: unknown) => {
      const parsed = Answer.safeParse(message);
      if (!parsed.success && !settled) console.error("Document worker: unexpected answer, document refused.");
      settle(parsed.success ? parsed.data : { status: "unreadable" });
    });
    worker.on("error", (error: unknown) => {
      // Out of its memory: the document is too big to read, whatever its compressed size.
      const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
      if (code === "ERR_WORKER_OUT_OF_MEMORY") {
        settle({ status: "too_big" });
        return;
      }
      // A bug or a parser crash, not a bad document: worth a line in the log.
      if (!settled) console.error(`Document worker failed: ${describeError(error)}.`);
      settle({ status: "unreadable" });
    });
    worker.on("exit", (exitCode: number) => {
      if (!settled) console.error(`Document worker stopped without answering (exit code ${exitCode}).`);
      settle({ status: "unreadable" });
    });
  });
}
