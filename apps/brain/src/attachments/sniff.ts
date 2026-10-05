const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** Compound File Binary: what Office writes for a password-protected .docx / .xlsx (document_read says so). */
export const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const UTF16_LE = [0xff, 0xfe];
const UTF16_BE = [0xfe, 0xff];

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const startsWith = (bytes: Uint8Array, signature: ArrayLike<number>, offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
};

/**
 * Does the content look like what its extension claims? Magic numbers for binary formats (.docx and .xlsx are
 * ZIP archives, or compound files once protected by a password); text must not contain NUL bytes (UTF-8 or
 * Windows-1252, like CSV files saved by a French Excel), unless it is UTF-16 with its byte order mark (Notepad, some
 * exports): then whole code units only.
 */
export function contentMatches(extension: string, bytes: Uint8Array): boolean {
  switch (extension) {
    case ".png":
      return startsWith(bytes, PNG);
    case ".jpg":
    case ".jpeg":
      return startsWith(bytes, JPEG);
    case ".gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case ".webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case ".pdf":
      return startsWith(bytes, ascii("%PDF-"));
    case ".docx":
    case ".xlsx":
      return startsWith(bytes, ZIP) || startsWith(bytes, CFB);
    case ".txt":
    case ".csv":
      if (startsWith(bytes, UTF16_LE) || startsWith(bytes, UTF16_BE)) return bytes.length % 2 === 0;
      return !bytes.includes(0);
    default:
      return false;
  }
}
