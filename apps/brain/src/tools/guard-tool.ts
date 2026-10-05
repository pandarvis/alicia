import type { Confirmed, ToolDefinition, ToolResult } from "../engine/tools.ts";
import type { ConfirmationOutcome } from "./confirmations.ts";
import type { TurnContext } from "./turn.ts";

/** What Alicia reads when nothing was done: in French, and firm about not trying again another way. */
const REFUSALS: Readonly<Record<Exclude<ConfirmationOutcome, "approved">, string>> = {
  refused: "Refusé : la personne a répondu non. N'insiste pas et ne cherche pas à contourner.",
  expired: "Pas de réponse à temps à la demande de confirmation : rien n'a été fait.",
  cancelled: "Demande annulée : rien n'a été fait.",
};

export function refusal(outcome: Exclude<ConfirmationOutcome, "approved">): ToolResult {
  return { text: REFUSALS[outcome], isError: true };
}

/**
 * One of our tools as the turn runs it: confirmation first when required (and only while the turn lasts), then
 * `run` with what was approved; untrusted output marked. The result asks nothing by itself any more.
 */
export function guardTool(definition: ToolDefinition, turn: TurnContext): ToolDefinition {
  // Every field but `confirmation`, copied one by one (the guarded tool must not ask a second time).
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    input: definition.input,
    ...(definition.untrustedOutput !== undefined ? { untrustedOutput: definition.untrustedOutput } : {}),
    async run(args) {
      let approved: Confirmed | undefined;
      if (definition.confirmation !== undefined) {
        const question = await definition.confirmation(args);
        if (question !== null) {
          const outcome = await turn.confirm({ tool: definition.name, summary: question.summary });
          if (outcome !== "approved") return refusal(outcome);
          // A yes that arrives once the turn is over (its answer crossed the end) does nothing.
          if (turn.ended) return refusal("cancelled");
          approved = { snapshot: question.snapshot };
        }
      }
      try {
        return await definition.run(args, approved);
      } finally {
        if (definition.untrustedOutput === true) turn.markUntrusted();
      }
    },
  };
}
