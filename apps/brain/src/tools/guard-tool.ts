import type { ToolDefinition, ToolResult } from "../engine/tools.ts";
import type { ConfirmationOutcome } from "./confirmations.ts";
import type { TurnContext } from "./turn.ts";

/** What Alicia reads when nothing was done: in French, and firm about not trying again another way. */
const REFUSALS: Readonly<Record<Exclude<ConfirmationOutcome, "approved">, string>> = {
  refused: "Refusé : la personne a répondu non. N'insiste pas et ne cherche pas à contourner.",
  expired: "Pas de réponse à la demande de confirmation (5 minutes) : rien n'a été fait.",
  cancelled: "Demande de confirmation annulée (connexion perdue) : rien n'a été fait.",
};

export function refusal(outcome: Exclude<ConfirmationOutcome, "approved">): ToolResult {
  return { text: REFUSALS[outcome], isError: true };
}

/** One of our tools as the turn runs it: confirmation first when required, untrusted output marked. */
export function guardTool(definition: ToolDefinition, turn: TurnContext): ToolDefinition {
  return {
    ...definition,
    async run(args) {
      if (definition.confirmation !== undefined) {
        const summary = await definition.confirmation(args);
        if (summary !== null) {
          const outcome = await turn.confirm({ tool: definition.name, summary });
          if (outcome !== "approved") return refusal(outcome);
        }
      }
      try {
        return await definition.run(args);
      } finally {
        if (definition.untrustedOutput === true) turn.markUntrusted();
      }
    },
  };
}
