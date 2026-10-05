import type { Confirmed, ToolDefinition, ToolResult } from "../engine/tools.ts";
import { type ConfirmationOutcome, TOOL_RUN_BUDGET_MS } from "./confirmations.ts";
import type { TurnContext } from "./turn.ts";

/** What Alicia reads when nothing was done: in French, and firm about not trying again another way. */
const REFUSALS: Readonly<Record<Exclude<ConfirmationOutcome, "approved">, string>> = {
  refused: "Refusé : la personne a répondu non. N'insiste pas et ne cherche pas à contourner.",
  expired: "Pas de réponse à temps à la demande de confirmation : rien n'a été fait.",
  cancelled: "Demande annulée : rien n'a été fait.",
};

/**
 * The tool went over its budget. It is not stopped (a tool cannot be interrupted safely half-way): its side
 * effect may still happen, so Alicia must not claim it failed, nor try again blindly.
 */
const TOO_SLOW: ToolResult = {
  text: "L'outil a mis trop de temps à répondre : il a peut-être agi quand même. Vérifie avant de recommencer, et dis-le à la personne.",
  isError: true,
};

export function refusal(outcome: Exclude<ConfirmationOutcome, "approved">): ToolResult {
  return { text: REFUSALS[outcome], isError: true };
}

/** Read through a call: the turn may end while a confirmation is awaited. */
function isOver(turn: TurnContext): boolean {
  return turn.ended;
}

export interface GuardOptions {
  /** How long `run` may take once allowed (default TOOL_RUN_BUDGET_MS; shortened by tests). */
  runBudgetMs?: number;
}

/** `run`, or TOO_SLOW once the budget is spent (whatever `run` later does is ignored). */
async function withinBudget(run: Promise<ToolResult>, budgetMs: number): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(TOO_SLOW);
    }, budgetMs);
  });
  // A failure after the budget was spent has nobody left to report to.
  run.catch(() => undefined);
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One of our tools as the turn runs it: nothing once the turn is over; confirmation first when required (and
 * only while the turn lasts), then `run` with what was approved, within its budget; untrusted output marked (the
 * tool's, or this one result's).
 * The result asks nothing by itself any more.
 */
export function guardTool(definition: ToolDefinition, turn: TurnContext, options: GuardOptions = {}): ToolDefinition {
  const budgetMs = options.runBudgetMs ?? TOOL_RUN_BUDGET_MS;
  const guarded: ToolDefinition = {
    ...definition,
    async run(args) {
      // A call that arrives once the turn ended (late engine, cancelled turn) does nothing, confirmed or not.
      if (isOver(turn)) return refusal("cancelled");
      let approved: Confirmed | undefined;
      if (definition.confirmation !== undefined) {
        const question = await definition.confirmation(args);
        if (question !== null) {
          const outcome = await turn.confirm({ tool: definition.name, summary: question.summary });
          if (outcome !== "approved") return refusal(outcome);
          // A yes that arrives once the turn is over (its answer crossed the end) does nothing.
          if (isOver(turn)) return refusal("cancelled");
          approved = { snapshot: question.snapshot };
        }
      }
      try {
        const result = await withinBudget(definition.run(args, approved), budgetMs);
        if (result.untrusted === true) turn.markUntrusted();
        return result;
      } finally {
        if (definition.untrustedOutput === true) turn.markUntrusted();
      }
    },
  };
  // The guarded tool must not ask a second time; every other field is kept as it is.
  delete guarded.confirmation;
  return guarded;
}
