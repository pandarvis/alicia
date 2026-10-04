import { describe, expect, test } from "vitest";
import { isTrustedSenderUrl } from "../src/main/trusted-sender.ts";

const FILE = "file:///C:/Apps/Alicia/resources/app/out/renderer/index.html";

describe("isTrustedSenderUrl", () => {
  test("production: only our renderer file is trusted", () => {
    const options = { rendererFileUrl: FILE, devUrl: undefined };
    expect(isTrustedSenderUrl(FILE, options)).toBe(true);
    expect(isTrustedSenderUrl("file:///C:/Users/someone/evil.html", options)).toBe(false);
    expect(isTrustedSenderUrl("http://evil.example/", options)).toBe(false);
    expect(isTrustedSenderUrl("http://localhost:5173/", options)).toBe(false);
  });

  test("dev: the dev server origin is trusted only when configured", () => {
    const dev = { rendererFileUrl: FILE, devUrl: "http://localhost:5173/" };
    expect(isTrustedSenderUrl("http://localhost:5173/", dev)).toBe(true);
    expect(isTrustedSenderUrl("http://localhost:5173/index.html", dev)).toBe(true);
    expect(isTrustedSenderUrl("http://localhost:5174/", dev)).toBe(false);
    expect(isTrustedSenderUrl("http://evil.example:5173/", dev)).toBe(false);
  });

  test("missing, empty or malformed URLs are never trusted", () => {
    const options = { rendererFileUrl: FILE, devUrl: "http://localhost:5173/" };
    expect(isTrustedSenderUrl(undefined, options)).toBe(false);
    expect(isTrustedSenderUrl("", options)).toBe(false);
    expect(isTrustedSenderUrl("not a url", options)).toBe(false);
    expect(isTrustedSenderUrl("", { rendererFileUrl: FILE, devUrl: "" })).toBe(false);
  });
});
