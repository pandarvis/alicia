import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { OfficeText } from "./office-text.ts";

/** What the worker may answer (checked: a worker is a boundary too). */
const Answer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("text"), text: z.string() }),
  z.object({ status: z.enum(["protected", "too_big", "unreadable"]) }),
]);

export type IsolatedOfficeText = OfficeText | { status: "too_slow" };

export interface IsolationLimits {
  /** Past this, the worker is stopped and the document refused (default 30 s). */
  timeoutMs?: number;
  /** Heap of the worker (default 512 MB): a document needing more is refused, the brain keeps running. */
  heapMb?: number;
}

const WORKER = new URL("./office-worker.ts", import.meta.url);
/** Node strips the worker's types itself when it can; otherwise (Node 22 under tsx or Vitest) it is asked to. */
const STRIP_TYPES = process.features.typescript === false
  ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]
  : [];

/**
 * Reads a Word / Excel document in a worker thread with its own memory limit and a hard deadline: a document that
 * would take the brain's memory or time (a huge workbook) is refused, and the brain's event loop never blocks.
 * Never throws.
 */
export function officeTextIsolated(bytes: Uint8Array, limits: IsolationLimits = {}): Promise<IsolatedOfficeText> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER, {
      workerData: bytes,
      execArgv: STRIP_TYPES,
      resourceLimits: { maxOldGenerationSizeMb: limits.heapMb ?? 512 },
    });
    const settle = (result: IsolatedOfficeText): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ status: "too_slow" });
    }, limits.timeoutMs ?? 30_000);
    worker.on("message", (message: unknown) => {
      const parsed = Answer.safeParse(message);
      settle(parsed.success ? parsed.data : { status: "unreadable" });
    });
    worker.on("error", (error: unknown) => {
      // Out of its memory: the document is too big to read, whatever its compressed size.
      const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
      settle({ status: code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_big" : "unreadable" });
    });
    worker.on("exit", () => {
      settle({ status: "unreadable" });
    });
  });
}
