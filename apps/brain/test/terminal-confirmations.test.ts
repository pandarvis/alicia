import { describe, expect, test } from "vitest";
import { TerminalConfirmations } from "../src/terminal-confirmations.ts";

const A = "7a2d4e6f-1b3c-4d5e-8f90-a1b2c3d4e5f6";
const B = "8b3e5f70-2c4d-4e6f-9a01-b2c3d4e5f607";

function setup() {
  const questions: { text: string; signal: AbortSignal; reply: (typed: string) => void; fail: () => void }[] = [];
  const answers: [string, boolean][] = [];
  const lines: string[] = [];
  const prompts = new TerminalConfirmations({
    ask: (text, signal) => new Promise((resolve, reject) => {
      const question = { text, signal, reply: resolve, fail: () => { reject(new Error("closed")); } };
      questions.push(question);
      signal.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
    }),
    answer: (id, approved) => { answers.push([id, approved]); },
    print: (line) => { lines.push(line); },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { prompts, questions, answers, lines, flush };
}

describe("TerminalConfirmations", () => {
  test("asks the card's question; « o » or « oui » is a yes, anything else a no", async () => {
    const { prompts, questions, answers, flush } = setup();
    prompts.request(A, "Oublier « lasagnes » ?");
    expect(questions[0]?.text).toBe("\n  [confirmation] Oublier « lasagnes » ? (o/n) ");
    questions[0]?.reply(" Oui ");
    await flush();
    prompts.request(B, "Oublier « course » ?");
    questions[1]?.reply("peut-être");
    await flush();
    expect(answers).toEqual([[A, true], [B, false]]);
  });

  test("two cards at once: one question at a time, in order", async () => {
    const { prompts, questions, answers, flush } = setup();
    prompts.request(A, "Premier ?");
    prompts.request(B, "Second ?");
    expect(questions).toHaveLength(1);
    questions[0]?.reply("o");
    await flush();
    expect(questions.map((q) => q.text)).toEqual(["\n  [confirmation] Premier ? (o/n) ", "\n  [confirmation] Second ? (o/n) "]);
    questions[1]?.reply("n");
    await flush();
    expect(answers).toEqual([[A, true], [B, false]]);
  });

  test("a card settled elsewhere (expired, turn over) stops being asked, and says how it ended", async () => {
    const { prompts, questions, answers, lines, flush } = setup();
    prompts.request(A, "Premier ?");
    prompts.request(B, "Second ?");
    prompts.settled(B, "cancelled");
    prompts.settled(A, "expired");
    await flush();
    expect(questions[0]?.signal.aborted).toBe(true);
    expect(questions).toHaveLength(1);
    expect(answers).toEqual([]);
    expect(lines).toEqual(["  [annulé]", "  [expiré]"]);
  });

  test("the turn's end drops every question still asked or waiting", async () => {
    const { prompts, questions, answers, flush } = setup();
    prompts.request(A, "Premier ?");
    prompts.request(B, "Second ?");
    prompts.clear();
    await flush();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.signal.aborted).toBe(true);
    expect(answers).toEqual([]);
  });

  test("a closed prompt (Ctrl+C) is a no", async () => {
    const { prompts, questions, answers, flush } = setup();
    prompts.request(A, "Premier ?");
    questions[0]?.fail();
    await flush();
    expect(answers).toEqual([[A, false]]);
  });

  test("an approved card prints nothing", () => {
    const { prompts, lines } = setup();
    prompts.settled(A, "approved");
    prompts.settled(B, "refused");
    expect(lines).toEqual(["  [refusé]"]);
  });
});
