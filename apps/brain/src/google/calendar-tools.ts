import { z } from "zod";
import { type ConfirmationAsk, defineTool, type ToolDefinition, type ToolResult } from "../engine/tools.ts";
import { oneLine } from "../memory/sheet.ts";
import { hasHiddenCharacters, truncate } from "../text.ts";
import { SUMMARY_MAX } from "../tools/turn.ts";
import { frameUntrusted } from "../tools/untrusted.ts";
import type { GoogleAccount } from "./account-store.ts";
import {
  CalendarApi, type CalendarEntry, type CalendarEvent, type EventFields, type EventTime, type EventTimeInput,
} from "./calendar-api.ts";
import type { GoogleAccess } from "./google-client.ts";
import { GoogleApiError, type GoogleFailure } from "./http.ts";
import {
  addDays, addMinutesLocal, daysBetween, formatDay, formatDayTime, formatTime, instantOfDateTime, IsoDate, localDay,
  LocalDateTime, localInstant, localMidnight, normalizeLocal,
} from "./time.ts";
import { ACCOUNT_NOT_FOUND, accountLabel, failureLine, failureText, guarded, NO_ACCOUNT } from "./tool-support.ts";

const MAX_DAYS = 31;
const DEFAULT_MINUTES = 60;
const WRITABLE: ReadonlySet<CalendarEntry["accessRole"]> = new Set(["owner", "writer"]);
const NO_INVITES =
  "Refusé : je n'ajoute jamais d'invités, car Google leur enverrait une invitation par mail. Crée l'événement sans invités ; la personne les préviendra elle-même.";
const HIDDEN = "Texte refusé : il contient des caractères invisibles. Réécris-le en clair.";
const NOT_APPROVED =
  "Refusé : rien n'a été fait, cette modification demande l'accord de la personne dans l'app. Rappelle l'outil pour qu'elle le donne.";
const NO_ANSWER =
  "Google n'a pas répondu pendant la question : rien n'a été fait. Réessaie dans un moment (la question sera reposée avec le détail de l'événement).";
const TRUNCATED = "(liste coupée : précise une période plus courte)";
const WHEN_HELP = "AAAA-MM-JJ pour une journée entière, AAAA-MM-JJTHH:MM (heure du foyer) sinon";
const THIS_EVENT = "cet événement";
/** An event title on a card: the rest of the card is for the changes asked. */
const CARD_TITLE_MAX = 80;
const UNREADABLE_TITLE = "(titre illisible)";
const TOO_LONG =
  "Texte trop long à afficher sur la carte de confirmation : rien n'a été fait. Fais la modification en plusieurs fois (le titre, puis le lieu par exemple).";
const UNREACHABLE = "Google ne répond pas pour l'instant : rien n'a été fait. Propose de réessayer plus tard.";
const NO_VERSION =
  "Google n'a pas donné la version de cet événement : rien n'a été fait, la modification ne pourrait pas être vérifiée.";
const UNREADABLE_CALENDAR = "(nom illisible)";
const CREATE_TOO_LONG =
  "Titre trop long à afficher sur la carte de confirmation : rien n'a été fait. Raccourcis le titre (le détail peut aller dans la description).";
const CALENDAR_CHANGED = "L'agenda n'est plus celui que la personne a approuvé : rien n'a été fait. Rappelle l'outil.";

const When = z.union([IsoDate, LocalDateTime]);
const CalendarId = z.string().min(1).max(300);
const EventId = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);
const Title = z.string().trim().min(1).max(200);
const Location = z.string().trim().max(300);
const Description = z.string().max(4000);

interface Target {
  account: GoogleAccount;
  calendar: CalendarEntry;
}

type Times = { start: EventTimeInput; end: EventTimeInput } | { error: string };
type Resolution = { target: Target } | { result: ToolResult };
/** An event as found for a question or a check: found, Google not answering, or another failure (kept to be said). */
type Lookup =
  | { kind: "found"; target: Target; event: CalendarEvent }
  | { kind: "unreachable" }
  | { kind: "failed"; failure: GoogleFailure };
/** A card to show, or what Alicia is told instead (nothing to confirm: `run` says why). */
type Card = { ask: ConfirmationAsk } | { result: ToolResult };

interface Change {
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  location?: string | undefined;
  description?: string | undefined;
}

const isDay = (value: string): boolean => !value.includes("T");

function calendarName(calendar: CalendarEntry): string {
  return calendar.summaryOverride ?? (calendar.summary !== "" ? calendar.summary : calendar.id);
}

function describeCalendar(target: Target): string {
  return `${accountLabel(target.account)} · agenda « ${oneLine(calendarName(target.calendar))} »`;
}

/** A calendar on a card: its name is written by whoever shares it, so never with characters the card could not show. */
function cardCalendar(target: Target): string {
  const name = calendarName(target.calendar);
  const shown = hasHiddenCharacters(name) ? UNREADABLE_CALENDAR : truncate(oneLine(name), CARD_TITLE_MAX);
  return `${accountLabel(target.account)} · agenda « ${shown} »`;
}

/** What a creation's card approves: this account's calendar, nothing else. */
function targetSnapshot(target: Target): string {
  return JSON.stringify([target.account.email, target.calendar.id]);
}

/** The parameters to pass back to the tools, under their own names. */
function reference(target: Target, eventId?: string): string {
  const event = eventId === undefined ? "" : ` eventId=${eventId}`;
  return `[account=${target.account.email} calendarId=${target.calendar.id}${event}]`;
}

function instantOf(time: EventTime, timeZone: string): number {
  if (time.date !== undefined) return localInstant(time.date, timeZone);
  return time.dateTime === undefined ? Number.NaN : instantOfDateTime(time.dateTime, time.timeZone ?? timeZone);
}

function describeWhen(start: EventTime, end: EventTime, timeZone: string): string {
  if (start.date !== undefined) {
    const last = addDays(end.date ?? start.date, -1);
    return last <= start.date
      ? `${formatDay(start.date)} (journée entière)`
      : `du ${formatDay(start.date)} au ${formatDay(last)} (journées entières)`;
  }
  const from = instantOf(start, timeZone);
  const to = instantOf(end, timeZone);
  if (Number.isNaN(from)) return "(horaire inconnu)";
  if (Number.isNaN(to)) return formatDayTime(from, timeZone);
  const sameDay = localDay(from, timeZone) === localDay(to, timeZone);
  return `${formatDayTime(from, timeZone)}–${sameDay ? formatTime(to, timeZone) : formatDayTime(to, timeZone)}`;
}

function titleOf(event: CalendarEvent): string {
  const title = oneLine(event.summary);
  return title === "" ? "(sans titre)" : title;
}

/**
 * The event's title as a card shows it: short enough to leave room for the changes asked, and never with characters
 * the card could not show (anyone who invites the account writes it).
 */
function cardTitle(event: CalendarEvent): string {
  return hasHiddenCharacters(event.summary) ? UNREADABLE_TITLE : truncate(titleOf(event), CARD_TITLE_MAX);
}

function describeEvent(target: Target, event: CalendarEvent, timeZone: string): string {
  const place = event.location !== undefined && event.location.trim() !== "" ? ` · lieu : ${oneLine(event.location)}` : "";
  // An occurrence is changed alone; the series has its own id, given as such.
  const series = event.recurringEventId === undefined ? "" : ` · répété : eventId=${event.recurringEventId} pour toute la série`;
  return `- ${describeWhen(event.start, event.end, timeZone)} · ${titleOf(event)}${place} · ${describeCalendar(target)} ${reference(target, event.id)}${series}`;
}

const FREQUENCIES: Readonly<Record<string, string>> = {
  DAILY: "chaque jour", WEEKLY: "chaque semaine", MONTHLY: "chaque mois", YEARLY: "chaque année",
};

/** "chaque semaine depuis le sam. 10 oct." for a series. */
function describeSeries(event: CalendarEvent, timeZone: string): string {
  const rule = (event.recurrence ?? []).find((line) => line.startsWith("RRULE:")) ?? "";
  const frequency = /(?:^RRULE:|;)FREQ=([A-Z]+)/.exec(rule)?.[1] ?? "";
  const interval = Number(/;INTERVAL=(\d+)/.exec(rule)?.[1] ?? "1");
  const every = interval === 1 ? (FREQUENCIES[frequency] ?? "répétée") : "répétée";
  const from = instantOf(event.start, timeZone);
  const first = event.start.date ?? (Number.isNaN(from) ? undefined : localDay(from, timeZone));
  return first === undefined ? every : `${every} depuis le ${formatDay(first)}`;
}

/** How the card names the event: a single one, one occurrence of a series, or the whole series (always said). */
function nameForCard(event: CalendarEvent, timeZone: string): string {
  if (event.recurrence !== undefined && event.recurrence.length > 0) {
    return `toute la série « ${cardTitle(event)} » (${describeSeries(event, timeZone)})`;
  }
  const when = describeWhen(event.start, event.end, timeZone);
  return event.recurringEventId === undefined
    ? `« ${cardTitle(event)} » (${when})`
    : `cette occurrence de « ${cardTitle(event)} » (${when})`;
}

/** Times as Google wants them: all-day ends are exclusive; a timed event lasts an hour by default. */
function eventTimes(start: string, end: string | undefined, timeZone: string): Times {
  if (end !== undefined && isDay(end) !== isDay(start)) {
    return { error: "Le début et la fin doivent être tous deux des jours (journée entière) ou tous deux des heures." };
  }
  if (isDay(start)) {
    const last = end ?? start;
    if (last < start) return { error: "La fin précède le début." };
    return { start: { date: start }, end: { date: addDays(last, 1) } };
  }
  const from = normalizeLocal(start);
  const to = end === undefined ? addMinutesLocal(start, DEFAULT_MINUTES) : normalizeLocal(end);
  if (to <= from) return { error: "La fin doit être après le début." };
  return { start: { dateTime: from, timeZone }, end: { dateTime: to, timeZone } };
}

/** A new start without an end keeps the event's length. */
function keptEnd(current: CalendarEvent, start: string, timeZone: string): string | undefined {
  if (isDay(start)) {
    if (current.start.date === undefined || current.end.date === undefined) return undefined;
    return addDays(start, Math.max(0, daysBetween(current.start.date, current.end.date) - 1));
  }
  if (current.start.date !== undefined) return undefined;
  const minutes = Math.round((instantOf(current.end, timeZone) - instantOf(current.start, timeZone)) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? addMinutesLocal(start, minutes) : undefined;
}

/** Text Alicia writes that the person could not fully see on a card or in the calendar. */
function hidesText(change: Change): boolean {
  return [change.title, change.location, change.description].some((text) => text !== undefined && hasHiddenCharacters(text));
}

/** What is wrong with a change before anything is asked or read (undefined: nothing). */
function changeProblem(change: Change, timeZone: string): string | undefined {
  if (hidesText(change)) return HIDDEN;
  if (change.end !== undefined && change.start === undefined) return "Donne aussi le nouveau début (start) avec la nouvelle fin.";
  if (change.start !== undefined && change.end !== undefined) {
    const times = eventTimes(change.start, change.end, timeZone);
    if ("error" in times) return times.error;
  }
  const empty = [change.title, change.start, change.location, change.description].every((value) => value === undefined);
  return empty ? "Rien à modifier." : undefined;
}

/** Whether outside content entered the turn: read when a tool runs (it changes during the turn). */
export interface TurnTrust {
  readonly untrusted: boolean;
}

const TRUSTED: TurnTrust = { untrusted: false };

/**
 * Calendar tools for the person a GoogleAccess is bound to. Once outside content entered the turn (`trust`), an
 * event is only created in a calendar the account does not own (shared by someone else, who would read it) after a
 * yes on a card: an injected instruction could otherwise write what it read into someone else's calendar.
 */
export function calendarTools(access: GoogleAccess, timeZone: string, trust: TurnTrust = TRUSTED): ToolDefinition[] {
  const calendar = new CalendarApi(access);

  /** The one writable calendar meant, or an answer for Alicia (not found, or a choice to ask the person). */
  async function resolveTarget(email: string | undefined, calendarId: string | undefined): Promise<Resolution> {
    let accounts = access.accounts();
    if (email !== undefined) {
      const account = access.account(email);
      if (account === undefined) return { result: ACCOUNT_NOT_FOUND };
      accounts = [account];
    }
    if (accounts.length === 0) return { result: { text: NO_ACCOUNT, isError: true } };
    const problems: string[] = [];
    const candidates: Target[] = [];
    for (const account of accounts) {
      try {
        for (const entry of await calendar.calendars(account)) {
          if (WRITABLE.has(entry.accessRole) && (calendarId === undefined || entry.id === calendarId)) {
            candidates.push({ account, calendar: entry });
          }
        }
      } catch (error) {
        problems.push(failureLine(account, error));
      }
    }
    const [only, ...others] = candidates;
    // A single candidate is only taken for granted when no account was left out because of an error.
    if (only !== undefined && others.length === 0 && (problems.length === 0 || email !== undefined)) return { target: only };
    if (only === undefined) {
      const missing = calendarId === undefined ? "Aucun agenda modifiable dans ces comptes." : "Agenda introuvable ou en lecture seule.";
      return { result: { text: [missing, ...problems].join("\n"), isError: true } };
    }
    if (others.length === 0) {
      // Taken for granted only when every account answered: the person says whether this one is right.
      return {
        result: {
          text: [
            "Un seul agenda trouvé, mais un autre compte n'a pas répondu : demande à la personne si c'est bien celui-ci, puis rappelle l'outil avec account et calendarId.",
            frameUntrusted("agendas", `- ${describeCalendar(only)} ${reference(only)}`),
            ...problems,
          ].join("\n"),
          // Calendar names are written by whoever shares the calendar: the conversation is no longer trusted.
          untrusted: true,
        },
      };
    }
    return {
      result: {
        text: [
          "Plusieurs agendas possibles : demande à la personne lequel choisir, puis rappelle l'outil avec account et calendarId.",
          // Calendar names can be chosen by whoever shares a calendar: framed as data.
          frameUntrusted("agendas", candidates.map((t) => `- ${describeCalendar(t)} ${reference(t)}`).join("\n")),
          ...problems,
        ].join("\n"),
        untrusted: true,
      },
    };
  }

  /** A creation needs a yes: outside content entered the turn and the calendar is not the account's own. */
  function createNeedsYes(target: Target): boolean {
    return trust.untrusted && target.calendar.accessRole !== "owner";
  }

  /** The card of a creation: the event as it will be written (title whole) and the calendar it goes to. */
  function createCard(target: Target, title: string, times: { start: EventTimeInput; end: EventTimeInput }): Card {
    const summary = [
      `Ajouter « ${oneLine(title)} » à l'agenda partagé ?`,
      describeWhen(times.start, times.end, timeZone),
      cardCalendar(target),
    ].join("\n");
    // The title is what is approved: shown whole, or not asked at all.
    if (summary.length > SUMMARY_MAX) return { result: { text: CREATE_TOO_LONG, isError: true } };
    return { ask: { summary, snapshot: targetSnapshot(target) } };
  }

  /** The writable calendar of this account with this id; GoogleApiError("not_found") when there is none. */
  async function findTarget(account: GoogleAccount, calendarId: string): Promise<Target> {
    const entry = (await calendar.calendars(account)).find((c) => c.id === calendarId && WRITABLE.has(c.accessRole));
    if (entry === undefined) throw new GoogleApiError("not_found");
    return { account, calendar: entry };
  }

  /** The event named, within the person's reach only (an account out of reach is never called). */
  async function lookUp(account: GoogleAccount, calendarId: string, eventId: string): Promise<Lookup> {
    try {
      const target = await findTarget(account, calendarId);
      const event = await calendar.event(account, target.calendar.id, eventId);
      return event.status === "cancelled" ? { kind: "failed", failure: "not_found" } : { kind: "found", target, event };
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      // Only Google not answering still asks (generically); anything else is for `run` to explain.
      return error.failure === "unavailable" ? { kind: "unreachable" } : { kind: "failed", failure: error.failure };
    }
  }

  /**
   * The card for a change: the event as found (single, occurrence or whole series) and its version as the snapshot.
   * No card (a result instead) when there is nothing to confirm: out of reach, unknown, no version to check, or a
   * question too long for the card to show whole — a card never hides part of what is approved. Google not
   * answering: a generic question with an empty snapshot, and `run` then does nothing.
   */
  async function card(
    verb: "Modifier" | "Supprimer", email: string, calendarId: string, eventId: string, changes: (event?: CalendarEvent) => string[],
  ): Promise<Card> {
    const account = access.account(email);
    if (account === undefined) return { result: ACCOUNT_NOT_FOUND };
    const found = await lookUp(account, calendarId, eventId);
    if (found.kind === "failed") return { result: { text: failureText(account, found.failure), isError: true } };
    const ask = found.kind === "unreachable"
      ? { summary: [`${verb} ${THIS_EVENT} ?`, ...changes()].join("\n"), snapshot: "" }
      : { summary: [`${verb} ${nameForCard(found.event, timeZone)} ?`, ...changes(found.event)].join("\n"), snapshot: found.event.etag };
    if (ask.snapshot === undefined) return { result: { text: NO_VERSION, isError: true } };
    if (ask.summary.length > SUMMARY_MAX) return { result: { text: TOO_LONG, isError: true } };
    return { ask: { summary: ask.summary, snapshot: ask.snapshot } };
  }

  /** The card's question, or null when there is nothing to confirm (`run` then says why). */
  async function ask(...params: Parameters<typeof card>): Promise<ConfirmationAsk | null> {
    const found = await card(...params);
    return "ask" in found ? found.ask : null;
  }

  /** What `run` answers when nothing was approved: why nothing will be done. */
  async function unapproved(...params: Parameters<typeof card>): Promise<ToolResult> {
    const found = await card(...params);
    if ("result" in found) return found.result;
    // Google did not answer while asking: said as such (the next call asks again).
    if (found.ask.snapshot === "") return { text: UNREACHABLE, isError: true };
    return { text: NOT_APPROVED, isError: true };
  }

  /** The lines of an update's card: each change, after the event's name. */
  function changeLines(change: Change, current: CalendarEvent | undefined): string[] {
    const lines: string[] = [];
    if (change.title !== undefined) lines.push(`Nouveau titre : « ${oneLine(change.title)} »`);
    if (change.start !== undefined) {
      const end = change.end ?? (current === undefined ? undefined : keptEnd(current, change.start, timeZone));
      const times = end === undefined && current === undefined ? undefined : eventTimes(change.start, end, timeZone);
      lines.push(times === undefined || "error" in times
        ? `Nouveau début : ${describeWhen(...startOnly(change.start), timeZone)}`
        : `Nouvel horaire : ${describeWhen(times.start, times.end, timeZone)}`);
    }
    if (change.location !== undefined) {
      lines.push(change.location === "" ? "Lieu retiré" : `Nouveau lieu : « ${oneLine(change.location)} »`);
    }
    if (change.description !== undefined) lines.push("Description modifiée");
    return lines;
  }

  /** A start shown alone (its end unknown while Google does not answer). */
  function startOnly(start: string): [EventTime, EventTime] {
    const time: EventTime = isDay(start) ? { date: start } : { dateTime: normalizeLocal(start), timeZone };
    return [time, isDay(start) ? { date: addDays(start, 1) } : time];
  }

  return [
    defineTool({
      name: "calendar_list",
      label: "Alicia consulte l'agenda…",
      description:
        "Liste les événements des agendas Famille et des agendas personnels de la personne qui te parle, entre deux jours inclus (AAAA-MM-JJ, 31 jours au plus). Chaque événement donne ses références entre crochets pour calendar_update / calendar_delete ; un événement répété donne aussi la référence de toute sa série.",
      input: { from: IsoDate, to: IsoDate },
      // Titles and places are written by anyone who can invite these accounts.
      untrustedOutput: true,
      async run({ from, to }) {
        if (to < from) return { text: "La date de fin précède la date de début.", isError: true };
        if (daysBetween(from, to) >= MAX_DAYS) return { text: `Demande au plus ${MAX_DAYS} jours à la fois.`, isError: true };
        const accounts = access.accounts();
        if (accounts.length === 0) return { text: NO_ACCOUNT, isError: true };
        const range = { timeMin: localMidnight(from, timeZone), timeMax: localMidnight(addDays(to, 1), timeZone) };
        const found: { at: number; line: string }[] = [];
        const problems: string[] = [];
        let truncated = false;
        for (const account of accounts) {
          try {
            for (const entry of await calendar.calendars(account)) {
              if ((entry.selected !== true && entry.primary !== true) || entry.accessRole === "freeBusyReader") continue;
              const target = { account, calendar: entry };
              const listed = await calendar.events(account, entry.id, range);
              truncated ||= listed.truncated;
              for (const event of listed.events) {
                if (event.status === "cancelled") continue;
                found.push({ at: instantOf(event.start, timeZone), line: describeEvent(target, event, timeZone) });
              }
            }
          } catch (error) {
            problems.push(failureLine(account, error));
          }
        }
        found.sort((a, b) => a.at - b.at);
        const period = from === to ? formatDay(from) : `du ${formatDay(from)} au ${formatDay(to)}`;
        const listing = found.length === 0
          ? `Aucun événement ${period}.`
          : `Événements ${period} :\n${frameUntrusted("agendas", found.map((f) => f.line).join("\n"))}`;
        return { text: [listing, ...(truncated ? [TRUNCATED] : []), ...problems].join("\n") };
      },
    }),
    defineTool({
      name: "calendar_create",
      label: "Alicia ajoute l'événement à l'agenda…",
      description: `Crée un événement dans un agenda Google (Famille ou perso de la personne qui te parle). start / end : ${WHEN_HELP} ; sans end : 1 h, ou la journée. Jamais d'invités. Sans account / calendarId, s'il y a plusieurs agendas, l'outil te donne le choix : demande à la personne.`,
      input: {
        title: Title,
        start: When,
        end: When.optional(),
        account: z.email().optional(),
        calendarId: CalendarId.optional(),
        location: Location.optional(),
        description: Description.optional(),
        // Only here to be refused clearly: an invitation would be an e-mail sent.
        attendees: z.array(z.string()).optional(),
      },
      // Only after outside content, and only for a calendar the account does not own (see calendarTools).
      async confirmation({ title, start, end, account, calendarId, location, description, attendees }) {
        if (!trust.untrusted || (attendees !== undefined && attendees.length > 0) || hidesText({ title, location, description })) {
          return null;
        }
        const times = eventTimes(start, end, timeZone);
        if ("error" in times) return null;
        const resolved = await resolveTarget(account, calendarId);
        if ("result" in resolved || !createNeedsYes(resolved.target)) return null;
        const card = createCard(resolved.target, title, times);
        return "ask" in card ? card.ask : null;
      },
      async run({ title, start, end, account, calendarId, location, description, attendees }, confirmed) {
        if (attendees !== undefined && attendees.length > 0) return { text: NO_INVITES, isError: true };
        if (hidesText({ title, location, description })) return { text: HIDDEN, isError: true };
        const times = eventTimes(start, end, timeZone);
        if ("error" in times) return { text: times.error, isError: true };
        const resolved = await resolveTarget(account, calendarId);
        if ("result" in resolved) return resolved.result;
        const { target } = resolved;
        if (confirmed !== undefined && confirmed.snapshot !== targetSnapshot(target)) return { text: CALENDAR_CHANGED, isError: true };
        if (confirmed === undefined && createNeedsYes(target)) {
          const card = createCard(target, title, times);
          return "result" in card ? card.result : { text: NOT_APPROVED, isError: true };
        }
        return guarded(target.account, async () => {
          const created = await calendar.insert(target.account, target.calendar.id, {
            summary: title,
            ...times,
            ...(location !== undefined ? { location } : {}),
            ...(description !== undefined ? { description } : {}),
          });
          // Only what Alicia wrote and the event's times: calendar names are written by whoever shares them.
          return { text: `Événement créé : ${describeWhen(created.start, created.end, timeZone)} · « ${oneLine(title)} » · ${accountLabel(target.account)} ${reference(target, created.id)}` };
        });
      },
    }),
    defineTool({
      name: "calendar_update",
      label: "Alicia modifie l'événement…",
      description: `Modifie un événement (titre, horaires, lieu, description) repéré par calendar_list : account, calendarId et eventId entre crochets. L'eventId d'une occurrence ne change qu'elle ; celui d'une série les change toutes. start / end : ${WHEN_HELP} ; un nouveau start sans end garde la durée. Jamais d'invités. La personne confirme dans l'app avant.`,
      input: {
        account: z.email(),
        calendarId: CalendarId,
        eventId: EventId,
        title: Title.optional(),
        start: When.optional(),
        end: When.optional(),
        location: Location.optional(),
        description: Description.optional(),
      },
      async confirmation({ account, calendarId, eventId, ...change }) {
        if (changeProblem(change, timeZone) !== undefined) return null;
        return ask("Modifier", account, calendarId, eventId, (current) => changeLines(change, current));
      },
      async run({ account: email, calendarId, eventId, ...change }, confirmed) {
        const problem = changeProblem(change, timeZone);
        if (problem !== undefined) return { text: problem, isError: true };
        if (confirmed === undefined) {
          return unapproved("Modifier", email, calendarId, eventId, (current) => changeLines(change, current));
        }
        if (confirmed.snapshot === "") return { text: NO_ANSWER, isError: true };
        const account = access.account(email);
        if (account === undefined) return ACCOUNT_NOT_FOUND;
        return guarded(account, async () => {
          const target = await findTarget(account, calendarId);
          const fields: EventFields = {
            ...(change.title !== undefined ? { summary: change.title } : {}),
            ...(change.location !== undefined ? { location: change.location } : {}),
            ...(change.description !== undefined ? { description: change.description } : {}),
          };
          if (change.start !== undefined) {
            const current = await calendar.event(account, target.calendar.id, eventId);
            // The event changed since the question: what was approved is no longer what would be written.
            if (current.etag !== confirmed.snapshot) throw new GoogleApiError("changed");
            const times = eventTimes(change.start, change.end ?? keptEnd(current, change.start, timeZone), timeZone);
            if ("error" in times) return { text: times.error, isError: true };
            fields.start = times.start;
            fields.end = times.end;
          }
          // If-Match: Google itself refuses the write if the event changed after the question.
          const updated = await calendar.update(account, target.calendar.id, eventId, fields, confirmed.snapshot);
          // Times and references only: the title and place may be someone else's text.
          return { text: `Événement modifié : ${describeWhen(updated.start, updated.end, timeZone)} · ${accountLabel(target.account)} ${reference(target, updated.id)}` };
        });
      },
    }),
    defineTool({
      name: "calendar_delete",
      label: "Alicia supprime l'événement…",
      description:
        "Supprime un événement repéré par calendar_list (account, calendarId, eventId entre crochets). L'eventId d'une occurrence ne supprime qu'elle ; celui d'une série les supprime toutes. La personne confirme dans l'app avant.",
      input: { account: z.email(), calendarId: CalendarId, eventId: EventId },
      async confirmation({ account, calendarId, eventId }) {
        return ask("Supprimer", account, calendarId, eventId, () => []);
      },
      async run({ account: email, calendarId, eventId }, confirmed) {
        if (confirmed === undefined) return unapproved("Supprimer", email, calendarId, eventId, () => []);
        if (confirmed.snapshot === "") return { text: NO_ANSWER, isError: true };
        const account = access.account(email);
        if (account === undefined) return ACCOUNT_NOT_FOUND;
        return guarded(account, async () => {
          const target = await findTarget(account, calendarId);
          // If-Match: nothing is deleted if the event changed after the question.
          await calendar.remove(account, target.calendar.id, eventId, confirmed.snapshot);
          return { text: `Événement supprimé (${accountLabel(target.account)}).` };
        });
      },
    }),
  ];
}
