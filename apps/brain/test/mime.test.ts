import { describe, expect, test } from "vitest";
import { buildRawMessage, encodeHeader } from "../src/google/mime.ts";

function decode(raw: string): { headers: string; body: string } {
  const message = Buffer.from(raw, "base64url").toString("utf8");
  const [headers = "", body = ""] = message.split("\r\n\r\n");
  return { headers, body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") };
}

describe("draft MIME", () => {
  test("headers, UTF-8 subject and body", () => {
    const raw = buildRawMessage({
      from: "kevin@example.com", to: ["ecole@example.com"], cc: ["elodie@example.com"],
      subject: "Réponse : sortie scolaire", body: "Bonjour,\nC'est signé.\nKévin",
      inReplyTo: "<sortie@ecole.example.com>", references: "<sortie@ecole.example.com>",
    });
    const { headers, body } = decode(raw);
    expect(headers).toContain("From: kevin@example.com");
    expect(headers).toContain("To: ecole@example.com");
    expect(headers).toContain("Cc: elodie@example.com");
    expect(headers).toContain("Subject: =?UTF-8?B?");
    expect(headers).toContain("In-Reply-To: <sortie@ecole.example.com>");
    expect(headers).toContain("Content-Type: text/plain; charset=\"UTF-8\"");
    expect(body).toBe("Bonjour,\r\nC'est signé.\r\nKévin");
  });

  test("a line break in a header is refused (header injection)", () => {
    expect(() => buildRawMessage({ from: "a@example.com", to: ["b@example.com"], cc: [], subject: "Hi\r\nBcc: x@evil.example", body: "x" }))
      .toThrow(/Subject/);
  });

  test("long non-ASCII headers are split into short encoded words", () => {
    const encoded = encodeHeader("é".repeat(60));
    for (const word of encoded.split("\r\n ")) expect(word.length).toBeLessThanOrEqual(75);
    expect(encodeHeader("Plain ASCII")).toBe("Plain ASCII");
  });

  const BASE = { from: "kevin@example.com", to: ["ecole@example.com"], cc: [], subject: "Sortie", body: "x" };

  test("no control character in any header: CR, LF, NUL, tab, vertical tab, DEL, next line", () => {
    for (const bad of ["\r", "\n", "\u0000", "\t", "\u000b", "\u007f", "\u0085", "\u2028"]) {
      const label = JSON.stringify(bad);
      expect(() => buildRawMessage({ ...BASE, subject: `Hi${bad}Bcc: x@evil.example` }), label).toThrow(/Subject/);
      expect(() => buildRawMessage({ ...BASE, inReplyTo: `<a@b>${bad}Bcc: x@evil.example` }), label).not.toThrow();
    }
  });

  test("addresses are plain addresses: no display name, list, group or injected header", () => {
    for (const bad of [
      "ecole@example.com, x@evil.example", "Ecole <ecole@example.com>", "x@evil.example\r\nBcc: y@evil.example",
      "undisclosed-recipients:;", "pas une adresse", "",
    ]) {
      expect(() => buildRawMessage({ ...BASE, to: [bad] }), bad).toThrow(/To/);
      expect(() => buildRawMessage({ ...BASE, cc: [bad] }), bad).toThrow(/Cc/);
    }
    expect(() => buildRawMessage({ ...BASE, from: "Kevin <kevin@example.com>" })).toThrow(/From/);
  });

  test("reply headers come from the original mail: only well-formed message ids are kept", () => {
    const { headers } = decode(buildRawMessage({
      ...BASE, inReplyTo: "<ok@ecole.example.com>", references: "<one@x.example> garbage <two@y.example>\r\nBcc: z@evil.example",
    }));
    expect(headers).toContain("In-Reply-To: <ok@ecole.example.com>");
    expect(headers).toContain("References: <one@x.example> <two@y.example>");
    expect(headers).not.toMatch(/Bcc|garbage|evil/);
    const none = decode(buildRawMessage({ ...BASE, inReplyTo: "not an id", references: "nothing here" })).headers;
    expect(none).not.toMatch(/In-Reply-To|References/);
  });

  test("many recipients: one address per folded line, never encoded", () => {
    const to = Array.from({ length: 40 }, (_, i) => `parent${i}@ecole-du-village.example.com`);
    const { headers } = decode(buildRawMessage({ ...BASE, to }));
    expect(headers).toContain("To: parent0@ecole-du-village.example.com,\r\n parent1@ecole-du-village.example.com,");
    expect(headers).not.toMatch(/To: =\?/);
    for (const line of headers.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });

  test("the subject never breaks the message: one header line, however long", () => {
    const { headers } = decode(buildRawMessage({ ...BASE, subject: "Sortie ".repeat(200) }));
    for (const line of headers.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });
});
