/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { AliciaBridge } from "../../shared/bridge.ts";

declare global {
  interface Window {
    alicia: AliciaBridge;
  }
}
