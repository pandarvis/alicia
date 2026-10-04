import type { SendMessage, ServerEvent } from "@alicia/protocol";
import { describe, expect, test, vi } from "vitest";
import { HubClient } from "../src/renderer/src/lib/hub-client.ts";
import type { BrainBridge } from "../src/shared/bridge.ts";
import type { ConnectionStatus } from "../src/shared/chat-connection.ts";

const MESSAGE: SendMessage = { type: "send", requestId: "7a1c2b9e-8a4d-4c1e-9b7a-2d5e6f708192", text: "Salut" };
const READY: ServerEvent = { type: "ready", person: { id: "kevin", name: "Kévin" } };

function setup(initial: ConnectionStatus = "ready", delivered = true) {
  const eventListeners: ((event: ServerEvent) => void)[] = [];
  const statusListeners: ((status: ConnectionStatus) => void)[] = [];
  const sent: SendMessage[] = [];
  const bridge: BrainBridge = {
    status: () => Promise.resolve(initial),
    send: (message) => {
      sent.push(message);
      return Promise.resolve(delivered);
    },
    onEvent: (listener) => {
      eventListeners.push(listener);
      return () => { eventListeners.splice(eventListeners.indexOf(listener), 1); };
    },
    onStatus: (listener) => {
      statusListeners.push(listener);
      return () => { statusListeners.splice(statusListeners.indexOf(listener), 1); };
    },
    onConversationsChanged: () => () => undefined,
  };
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const undelivered: string[] = [];
  const hub = new HubClient(bridge, {
    onEvent: (event) => { events.push(event); },
    onStatus: (status) => { statuses.push(status); },
    onUndelivered: (requestId) => { undelivered.push(requestId); },
  });
  return {
    hub, sent, events, statuses, undelivered, eventListeners, statusListeners,
    pushEvent: (event: ServerEvent) => { for (const listener of [...eventListeners]) listener(event); },
    pushStatus: (status: ConnectionStatus) => { for (const listener of [...statusListeners]) listener(status); },
  };
}

describe("HubClient", () => {
  test("mirrors the main process's connection status and relays its events", async () => {
    const { hub, events, statuses, pushEvent, pushStatus } = setup();
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["ready"]); });
    pushEvent(READY);
    pushStatus("offline");
    expect(events).toEqual([READY]);
    expect(statuses).toEqual(["ready", "offline"]);
    expect(hub.status).toBe("offline");
  });

  test("send is refused until ready, then handed to the main process", async () => {
    const { hub, sent, statuses, pushStatus } = setup("connecting");
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["connecting"]); });
    expect(hub.send(MESSAGE)).toBe(false);
    pushStatus("ready");
    expect(hub.send(MESSAGE)).toBe(true);
    expect(sent).toEqual([MESSAGE]);
  });

  test("a message the main process could not deliver is reported", async () => {
    const { hub, statuses, undelivered } = setup("ready", false);
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["ready"]); });
    expect(hub.send(MESSAGE)).toBe(true);
    await vi.waitFor(() => { expect(undelivered).toEqual([MESSAGE.requestId]); });
  });

  test("stop unsubscribes, and nothing is sent afterwards", async () => {
    const { hub, statuses, eventListeners, statusListeners } = setup();
    hub.start();
    await vi.waitFor(() => { expect(statuses).toEqual(["ready"]); });
    hub.stop();
    expect([eventListeners.length, statusListeners.length]).toEqual([0, 0]);
    expect(hub.send(MESSAGE)).toBe(false);
  });
});
