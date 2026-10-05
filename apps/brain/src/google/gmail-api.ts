import { z } from "zod";
import type { GoogleAccount } from "./account-store.ts";
import { type GoogleRequester, pathSegment } from "./http.ts";
import { attachmentNames, extractText, headerOf, htmlToText, MessagePart } from "./mail-text.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Most mails one search reads (each one is a call). */
export const MAX_SEARCH = 25;

const MessageRef = z.object({ id: z.string().min(1), threadId: z.string().min(1) });
const MessageList = z.object({ messages: z.array(MessageRef).default([]) });
const Message = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  snippet: z.string().default(""),
  labelIds: z.array(z.string()).default([]),
  internalDate: z.string().regex(/^\d+$/).optional(),
  payload: MessagePart.optional(),
});
type Message = z.infer<typeof Message>;
const DraftCreated = z.object({ id: z.string().min(1) });

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  /** Epoch ms (Gmail's internalDate). */
  receivedAt: number | undefined;
  snippet: string;
  unread: boolean;
}

export interface Mail extends MailSummary {
  to: string;
  text: string;
  attachments: string[];
  /** Message-ID header, for replies (In-Reply-To / References). */
  messageId: string | undefined;
  references: string | undefined;
}

function summary(message: Message): MailSummary {
  return {
    id: message.id,
    threadId: message.threadId,
    from: headerOf(message.payload, "From") ?? "",
    subject: headerOf(message.payload, "Subject") ?? "",
    receivedAt: message.internalDate === undefined ? undefined : Number(message.internalDate),
    snippet: htmlToText(message.snippet),
    unread: message.labelIds.includes("UNREAD"),
  };
}

const messageUrl = (id: string): string => `${BASE}/messages/${pathSegment(id)}`;

/**
 * Gmail v1: search, read, create a draft. There is deliberately no method that sends,
 * and none may ever be added (see the "no sending" test).
 */
export class GmailApi {
  readonly #google: GoogleRequester;

  constructor(google: GoogleRequester) {
    this.#google = google;
  }

  /** Summaries of the mails Gmail finds for `query` (its own search syntax), newest first, at most MAX_SEARCH. */
  async search(account: GoogleAccount, query: string, max: number): Promise<MailSummary[]> {
    const limit = Math.max(1, Math.min(MAX_SEARCH, Math.floor(max)));
    const list = await this.#google.json(account, {
      method: "GET", url: `${BASE}/messages`, query: { q: query, maxResults: limit },
    }, MessageList);
    const found: MailSummary[] = [];
    for (const ref of list.messages.slice(0, limit)) {
      const message = await this.#google.json(account, {
        method: "GET", url: messageUrl(ref.id), query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
      }, Message);
      found.push(summary(message));
    }
    return found;
  }

  async read(account: GoogleAccount, id: string): Promise<Mail> {
    const message = await this.#google.json(account, { method: "GET", url: messageUrl(id), query: { format: "full" } }, Message);
    return {
      ...summary(message),
      to: headerOf(message.payload, "To") ?? "",
      text: extractText(message.payload),
      attachments: attachmentNames(message.payload),
      messageId: headerOf(message.payload, "Message-ID"),
      references: headerOf(message.payload, "References"),
    };
  }

  /** Creates a draft (never sent). `raw`: see mime.ts. */
  async createDraft(account: GoogleAccount, raw: string, threadId?: string): Promise<string> {
    const draft = await this.#google.json(account, {
      method: "POST",
      url: `${BASE}/drafts`,
      body: { message: { raw, ...(threadId !== undefined ? { threadId } : {}) } },
    }, DraftCreated);
    return draft.id;
  }
}
