import { expect, test } from "vitest";
import { contentMatches } from "../src/attachments/sniff.ts";
import { PDF_BYTES as PDF, PNG_BYTES as PNG } from "./helpers.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => new TextEncoder().encode(text);

test.each([
  [".png", PNG, true],
  [".jpg", bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16), true],
  [".jpeg", bytes(0xff, 0xd8, 0xff, 0xe1), true],
  [".gif", ascii("GIF89a…"), true],
  [".webp", ascii("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "), true],
  [".pdf", PDF, true],
  [".docx", bytes(0x50, 0x4b, 0x03, 0x04, 20, 0), true],
  [".xlsx", bytes(0x50, 0x4b, 0x03, 0x04, 20, 0), true],
  [".txt", ascii("Liste : pain, œufs"), true],
  [".csv", bytes(0x44, 0xe9, 0x70, 0x65, 0x6e, 0x73, 0x65, 0x3b, 0x31, 0x32), true], // "Dépense;12" in Windows-1252
  [".pdf", PNG, false],
  [".png", PDF, false],
  [".docx", PDF, false],
  [".webp", ascii("RIFF\u0000\u0000\u0000\u0000WAVEfmt "), false],
  [".txt", bytes(0x41, 0x00, 0x42), false],
  // UTF-16 (Notepad, some Excel exports): NUL bytes are expected after its byte order mark.
  [".txt", bytes(0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00), true],
  [".csv", bytes(0xfe, 0xff, 0x00, 0x41, 0x00, 0x3b), true],
  [".txt", bytes(0xff, 0xfe, 0x41, 0x00, 0xe9), false],
  [".exe", PDF, false],
])("%s with these bytes → %s", (extension, content, expected) => {
  expect(contentMatches(extension, content)).toBe(expected);
});
