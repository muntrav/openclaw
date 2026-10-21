import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { planCronFailureRepairTurn } from "./mock-openai-cron-failure-repair.js";
import { planCronParentBoardTurn } from "./mock-openai-cron-parent-board.js";

/** Scripted scheduled-run QA flows whose prompts carry a distinct marker. */
export function planCronScheduledTurn(
  prompt: string,
  input: ResponsesInputItem[],
): StreamEvent[] | null {
  return planCronFailureRepairTurn(prompt, input) ?? planCronParentBoardTurn(prompt, input);
}
