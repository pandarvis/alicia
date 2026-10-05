import { describe, expect, test } from "vitest";
import { attachmentNames, extractText, headerOf, htmlToText, type MessagePart } from "../src/google/mail-text.ts";

const b64 = (text: string, encoding: BufferEncoding = "utf8") => Buffer.from(text, encoding).toString("base64url");

describe("mail text", () => {
  test("prefers text/plain, never an attachment", () => {
    const payload: MessagePart = {
      mimeType: "multipart/mixed",
      headers: [{ name: "subject", value: "Bonjour" }],
      parts: [
        { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("pièce jointe") } },
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/html", body: { data: b64("<p>HTML</p>") } },
          { mimeType: "text/plain", body: { data: b64("Texte brut é") } },
        ] },
      ],
    };
    expect(extractText(payload)).toBe("Texte brut é");
    expect(attachmentNames(payload)).toEqual(["notes.txt"]);
    expect(headerOf(payload, "Subject")).toBe("Bonjour");
  });

  test("falls back to HTML, decodes the declared charset", () => {
    const payload: MessagePart = {
      mimeType: "text/html",
      headers: [{ name: "Content-Type", value: "text/html; charset=\"ISO-8859-1\"" }],
      body: { data: b64("<style>p{}</style><p>Réunion&nbsp;à 9&#104;</p><script>evil()</script>", "latin1") },
    };
    expect(extractText(payload)).toBe("Réunion à 9h");
  });

  test("an unclosed script or style hides nothing after it as text", () => {
    expect(htmlToText("<p>Bonjour</p><script>steal(document.cookie)")).toBe("Bonjour");
    expect(htmlToText("<p>Bonjour</p><style>p { color: red }")).toBe("Bonjour");
  });

  test("a mail nested absurdly deep is read without blowing the stack", () => {
    let part: MessagePart = { mimeType: "text/plain", body: { data: b64("tout au fond") } };
    for (let i = 0; i < 5000; i++) part = { mimeType: "multipart/mixed", parts: [part, { mimeType: "application/pdf", filename: `f${i}.pdf` }] };
    expect(() => extractText(part)).not.toThrow();
    expect(() => attachmentNames(part)).not.toThrow();
    expect(attachmentNames(part).length).toBeLessThanOrEqual(64);
  });

  test("a huge HTML body is cut before being cleaned", () => {
    const html = `<p>${"x".repeat(2_000_000)}</p>`;
    const payload: MessagePart = { mimeType: "text/html", body: { data: b64(html) } };
    expect(extractText(payload).length).toBeLessThanOrEqual(200_000);
  });

  test("html to text keeps line breaks and drops markup", () => {
    expect(htmlToText("<div>Un<br>Deux</div><p>Trois &amp; &lt;quatre&gt;</p>")).toBe("Un\nDeux\nTrois & <quatre>");
  });
});
