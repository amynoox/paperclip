// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { QuestionResponseSummary } from "./QuestionForm";

vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a>, useNavigate: () => vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// STUDIO-0054: the answered summary renders the question text as Markdown too.
describe("QuestionResponseSummary", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("renders the question prompt as Markdown next to its answer", async () => {
    await act(async () => root.render(<ThemeProvider><QuestionResponseSummary
      questionSet={{ schema: "paperclip.question_set.v1", questions: [{ id: "q", prompt: "**Décision** sur la PR", required: true,
        answerMode: "single_select", options: [{ id: "merge", label: "Fusionner" }] }] }}
      response={{ schema: "paperclip.question_response.v1", answers: { q: { selectedOptionIds: ["merge"] } } }} /></ThemeProvider>));
    expect(host.querySelector("strong")?.textContent).toBe("Décision");
    expect(host.textContent).toContain("Fusionner");
    expect(host.textContent).not.toContain("**Décision**");
  });
});
