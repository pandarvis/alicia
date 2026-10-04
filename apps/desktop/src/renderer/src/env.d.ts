/// <reference types="svelte" />
/// <reference types="vite/client" />
import type { AliciaBridge } from "../../shared/session.ts";

declare global {
  interface Window {
    alicia: AliciaBridge;
  }
}
