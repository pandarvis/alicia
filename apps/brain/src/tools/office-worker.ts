// Entry of the document worker (see office-isolated.ts): reads one Word / Excel document, answers once, ends.
// Loaded with Node's own type stripping: relative `.ts` imports and plain JavaScript packages only.
import { parentPort, workerData } from "node:worker_threads";
import { officeText } from "./office-text.ts";

const bytes: unknown = workerData;
if (bytes instanceof Uint8Array) {
  parentPort?.postMessage(await officeText(bytes));
} else {
  parentPort?.postMessage({ status: "unreadable" });
}
