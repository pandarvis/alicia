import type { WebSocket } from "ws";
import type { DependancesServeur } from "./serveur.ts";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function brancherWs(socket: WebSocket, _deps: DependancesServeur): void {
  socket.close(1013, "Pas encore disponible");
}
