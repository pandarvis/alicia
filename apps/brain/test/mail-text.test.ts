import { describe, expect, test } from "vitest";
import {
  attachmentNames, decodeBody, extractText, headerOf, htmlToText, MessagePart,
} from "../src/google/mail-text.ts";

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

  test("comments are dropped, an unclosed one hides everything after it", () => {
    expect(htmlToText("<p>Un</p><!-- <p>caché</p> --><p>Deux</p>")).toBe("Un\nDeux");
    expect(htmlToText("<p>Un</p><!-- <p>caché</p>")).toBe("Un");
    expect(htmlToText("<p>A</p><head><title>x</title></head><style>p{}</style><p>B</p><script>x</script>C")).toBe("A\nB\nC");
    expect(htmlToText("<p>A</p><SCRIPT type=x>y</Script ><p>B</p>")).toBe("A\nB");
  });

  test("hostile HTML is cleaned in linear time (no pattern can freeze the brain)", () => {
    for (const html of [
      "<".repeat(200_000), "<style>".repeat(28_000), "<script>".repeat(28_000), "<head ".repeat(33_000),
      "<!--".repeat(50_000), "<!--<style>".repeat(18_000), "<a ".repeat(66_000), `${"&#x".repeat(66_000)}1`,
      "<br".repeat(66_000), "</p".repeat(66_000),
    ]) {
      const started = performance.now();
      htmlToText(html);
      expect(performance.now() - started, html.slice(0, 12)).toBeLessThan(1_000);
    }
  });

  test("an unknown charset falls back to UTF-8", () => {
    expect(decodeBody(b64("été"), "x-unknown-charset")).toBe("été");
  });

  test("an answer nested absurdly deep is parsed without blowing the stack; the deep parts are not read", () => {
    let part: unknown = { mimeType: "text/plain", body: { data: b64("tout au fond") } };
    for (let i = 0; i < 100_000; i++) part = { mimeType: "multipart/mixed", parts: [part] };
    const parsed = MessagePart.safeParse({
      mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", body: { data: b64("en haut") } }, part],
    });
    expect(parsed.success).toBe(true);
    expect(extractText(parsed.data)).toBe("en haut");
  });

  test("html to text keeps line breaks and drops markup", () => {
    expect(htmlToText("<div>Un<br>Deux</div><p>Trois &amp; &lt;quatre&gt;</p>")).toBe("Un\nDeux\nTrois & <quatre>");
  });
});
