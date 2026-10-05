import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadClientSecret, parseClientSecret } from "../src/google/client-secret.ts";
import { createTempDir } from "./helpers.ts";

const INSTALLED = JSON.stringify({
  installed: {
    client_id: "123-abc.apps.googleusercontent.com",
    project_id: "alicia",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    client_secret: "GOCSPX-secret",
    redirect_uris: ["http://localhost"],
  },
});

/** The message of what `run` throws (fails the test when it does not throw). */
function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
}

describe("google_client_secret.json", () => {
  test("reads a desktop (installed) client", () => {
    expect(parseClientSecret(INSTALLED)).toEqual({
      clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret",
    });
  });

  test("a web client is refused with a clear French message", () => {
    const web = JSON.stringify({ web: { client_id: "1-a.apps.googleusercontent.com", client_secret: "s" } });
    expect(() => parseClientSecret(web)).toThrow(/Application de bureau/);
  });

  test("garbage is refused without echoing the content", () => {
    const leaky = "{\"installed\":{\"client_secret\":\"GOCSPX-leak\"}}";
    expect(thrown(() => parseClientSecret(leaky))).toMatch(/google_client_secret/);
    expect(thrown(() => parseClientSecret(leaky))).not.toContain("GOCSPX-leak");
    expect(thrown(() => parseClientSecret("not json GOCSPX-leak"))).toMatch(/google_client_secret/);
    expect(thrown(() => parseClientSecret("not json GOCSPX-leak"))).not.toContain("GOCSPX-leak");
  });

  test("loads the file named in the config; a missing file says which setting to check", () => {
    const dir = createTempDir();
    const path = join(dir, "google_client_secret.json");
    writeFileSync(path, INSTALLED);
    expect(loadClientSecret(path).clientId).toBe("123-abc.apps.googleusercontent.com");
    expect(() => loadClientSecret(join(dir, "absent.json"))).toThrow(/google\.clientSecretFile/);
  });
});
