import alertUrl from "../assets/mascot/alert.webp";
import errorUrl from "../assets/mascot/error.webp";
import ideaUrl from "../assets/mascot/idea.webp";
import idleUrl from "../assets/mascot/idle.webp";
import listeningUrl from "../assets/mascot/listening.webp";
import sleepingUrl from "../assets/mascot/sleeping.webp";
import speakingUrl from "../assets/mascot/speaking.webp";
import successUrl from "../assets/mascot/success.webp";
import thinkingUrl from "../assets/mascot/thinking.webp";
import type { MascotState } from "../../../shared/mascot.ts";

export const MASCOT_IMAGES: Readonly<Record<MascotState, string>> = {
  idle: idleUrl,
  sleeping: sleepingUrl,
  listening: listeningUrl,
  thinking: thinkingUrl,
  speaking: speakingUrl,
  success: successUrl,
  alert: alertUrl,
  error: errorUrl,
  idea: ideaUrl,
};
