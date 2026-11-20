/**
 * STUDIO-0074 (L15): what a Retry request carries when pause-resume-continuation.ts files it again after the run
 * that continued work a pause cut could not start. Kept apart, with no import, so that the wake queue can read it.
 */
export const PAUSE_CUT_WORK_ASKED_AGAIN = "pauseCutWorkAskedAgain";

export type PauseCutWorkAskedAgain = {
  /** The rank of this request in its series: 1 for the first one filed after a failed start. */
  attempt: number;
  /** When the first start of the series failed, in ms. */
  seriesStartedAt: number;
  /** This request does not start before this time, in ms. */
  notBefore: number;
  /** The run the pause cut. */
  cutRunId: string;
};

/** The mark of a request asked again, read from the payload of its wake request; null for any other request. */
export function readPauseCutWorkAskedAgain(payload: unknown): PauseCutWorkAskedAgain | null {
  const mark = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)[PAUSE_CUT_WORK_ASKED_AGAIN] : null;
  if (mark === null || typeof mark !== "object") return null;
  const { attempt, seriesStartedAt, notBefore, cutRunId } = mark as Record<string, unknown>;
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0
    && typeof seriesStartedAt === "number" && Number.isFinite(seriesStartedAt)
    && typeof notBefore === "number" && Number.isFinite(notBefore) && typeof cutRunId === "string"
    ? { attempt, seriesStartedAt, notBefore, cutRunId } : null;
}
