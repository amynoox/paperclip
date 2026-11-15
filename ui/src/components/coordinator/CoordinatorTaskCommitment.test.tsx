// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoordinatorTaskMotion } from "./CoordinatorTaskCommitment";
import { TaskChatCompactInteractionCard } from "../task-chat/TaskChatCompactInteractionCard";
import { answeredAskUserQuestionsInteraction, pendingSuggestedTasksInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { TooltipProvider } from "../ui/tooltip";
import { ThemeProvider } from "@/context/ThemeContext";

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, loaded: true, userId: "viewer" }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }));
const summaries = vi.hoisted(() => ({ rows: null as null | Array<Record<string, unknown>> }));
vi.mock("@/api/issues", () => ({ issuesApi: { summaries: vi.fn(async () => summaries.rows ?? [{ id: "task-created", identifier: "PAPER-108", title: "Write the launch post", status: "todo" }]) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); client.clear(); vi.restoreAllMocks(); summaries.rows = null; });

function render(interaction: typeof pendingSuggestedTasksInteraction, onAcceptInteraction = vi.fn(), onRejectInteraction = vi.fn()) {
  return act(() => root.render(<QueryClientProvider client={client}><TooltipProvider>
    <TaskChatCompactInteractionCard interaction={interaction} onAcceptInteraction={onAcceptInteraction} onRejectInteraction={onRejectInteraction} />
  </TooltipProvider></QueryClientProvider>));
}

describe("Coordinator task commitment", () => {
  it("does not claim creation when acceptance is still pending or failed", async () => {
    let fail!: (reason: Error) => void;
    const accept = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    await render(pendingSuggestedTasksInteraction, accept);
    await act(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Create")!.click());
    expect(accept).toHaveBeenCalledOnce();
    expect(host.querySelector(".coordinator-created-task")).toBeNull();
    await act(() => fail(new Error("Creation could not be saved")));
    expect(host.textContent).toContain("Creation could not be saved");
    expect(host.querySelector(".coordinator-created-task")).toBeNull();
  });

  it("distinguishes rejection from revision and restores actions on cancel", async () => {
    const accept = vi.fn();
    const reject = vi.fn();
    const button = (label: string) => [...host.querySelectorAll("button")].find(item => item.textContent === label)!;
    await render(pendingSuggestedTasksInteraction, accept, reject);
    expect(host.querySelector("h3")?.textContent).toBe("Suggested Task");
    expect(["Reject", "Revise…", "Create"].every(label => button(label))).toBe(true);
    await act(() => button("Revise…").click());
    expect(button("Create")).toBeUndefined();
    expect(button("Reject")).toBeUndefined();
    expect(button("Request revision").disabled).toBe(true);
    await act(() => button("Cancel").click());
    expect(button("Create")).toBeDefined();
    expect(reject).not.toHaveBeenCalled();
    await act(() => button("Revise…").click());
    const field = host.querySelector("textarea")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Start with a smaller draft");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => button("Request revision").click());
    expect(reject).toHaveBeenCalledWith(pendingSuggestedTasksInteraction, "Start with a smaller draft");
    expect(accept).not.toHaveBeenCalled();
    await act(() => button("Cancel").click());
    await act(() => button("Reject").click());
    expect(reject).toHaveBeenLastCalledWith(pendingSuggestedTasksInteraction, undefined);
  });

  it("uses accepted server identities without navigating, then shows canonical current status", async () => {
    await render(pendingSuggestedTasksInteraction);
    await render({ ...pendingSuggestedTasksInteraction, status: "accepted", result: { version: 1, createdTasks: [{ clientKey: "launch", issueId: "task-created", identifier: "PAPER-108", title: "Write the launch post" }] } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const link = host.querySelector<HTMLAnchorElement>(".coordinator-created-task");
    expect(link?.getAttribute("href")).toBe("/issues/PAPER-108");
    expect(link?.textContent).toContain("PAPER-108");
    expect(link?.textContent).toContain("Write the launch post");
    expect(link?.querySelector('[aria-label="Todo"]')).not.toBeNull();
  });

  it("starts resizing and light together only on the observed creation transition", async () => {
    const animation = { cancel: vi.fn() };
    const animate = vi.fn().mockReturnValue(animation);
    HTMLElement.prototype.animate = animate;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const phase = (this as HTMLElement).parentElement?.dataset.phase;
      return { width: 500, height: phase === "created" ? 80 : 240 } as DOMRect;
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: (name: string) => name.endsWith("ease") ? "ease-out" : name.includes("light") ? "1400ms" : name.includes("morph") ? "480ms" : "880ms" } as CSSStyleDeclaration);
    const date = new Date(Date.now() + 1000).toISOString();
    const paint = (phase: "suggested" | "created") => act(() => root.render(<CoordinatorTaskMotion eventId="motion-live" createdAt={date} phase={phase}><span>{phase}</span></CoordinatorTaskMotion>));
    await paint("suggested");
    expect(host.firstElementChild?.getAttribute("data-motion")).toBe("arrive");
    await paint("created");
    expect(host.firstElementChild?.getAttribute("data-motion")).toBe("gather");
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 480 });
    await act(() => root.render(null)); animate.mockClear();
    await paint("created");
    expect(host.firstElementChild?.hasAttribute("data-motion")).toBe(false);
    expect(animate).not.toHaveBeenCalled();
  });

  it("settles immediately for reduced motion", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await act(() => root.render(<CoordinatorTaskMotion eventId="reduced-motion" phase="suggested" createdAt={new Date()}><span>Task suggestion</span></CoordinatorTaskMotion>));
    expect(host.textContent).toContain("Task suggestion");
    expect(host.firstElementChild?.hasAttribute("data-motion")).toBe(false);
  });

  it("settles saved decisions immediately for reduced motion and does not replay them on return", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    const onSettled = vi.fn();
    const createdAt = new Date(0).toISOString();
    const paint = (phase: "pending" | "resolved") => act(() => root.render(
      <CoordinatorTaskMotion eventId="decision-reduced-motion" phase={phase} createdAt={createdAt} onSettled={onSettled}>
        <span>{phase}</span>
      </CoordinatorTaskMotion>,
    ));
    await paint("pending");
    expect(onSettled).not.toHaveBeenCalled();
    await paint("resolved");
    expect(onSettled).toHaveBeenCalledOnce();
    expect(animate).not.toHaveBeenCalled();
    expect(host.firstElementChild?.hasAttribute("data-motion")).toBe(false);
    await act(() => root.render(null));
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await paint("resolved");
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(animate).not.toHaveBeenCalled();
    expect(host.firstElementChild?.hasAttribute("data-motion")).toBe(false);
  });

  it("draws a created task from its full summary state, matching the task pane (BUG-07)", async () => {
    summaries.rows = [{ id: "task-created", identifier: "PAPER-108", title: "Write the launch post", status: "blocked", displayStatus: "blocked",
      externalConversationState: null, blockerAttention: { state: "covered", reason: "active_child", unresolvedBlockerCount: 1, coveredBlockerCount: 1,
        attentionBlockerCount: 0, stalledBlockerCount: 0, sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null } }];
    await render({ ...pendingSuggestedTasksInteraction, status: "accepted", result: { version: 1, createdTasks: [{ clientKey: "launch", issueId: "task-created", identifier: "PAPER-108", title: "Write the launch post" }] } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const glyph = host.querySelector<SVGElement>(".coordinator-created-task svg[role='img']");
    expect(glyph?.style.color).toBe("var(--status-task-icon-in_queue)");
  });
});

// STUDIO-0054: bench, lot 20 (15 Nov 2026). Once answered, a question shrank to its receipt and the question set's
// description, the context the person read before answering, was no longer shown anywhere in the task.
describe("answered question receipt", () => {
  const withContext = (description?: string) => {
    const base = answeredAskUserQuestionsInteraction;
    return { ...base, payload: { ...base.payload, ...(description === undefined ? {} : { questionSet: {
      schema: "paperclip.question_set.v1" as const, description,
      questions: base.payload.questions.map((question) => ({ id: question.id, prompt: question.prompt, required: question.required ?? false,
        answerMode: question.selectionMode === "multi" ? "multi_select" as const : "single_select" as const,
        options: question.options.map((option) => ({ id: option.id, label: option.label })) })),
    } }) } };
  };
  const paint = (interaction: unknown) => act(() => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
    <TaskChatCompactInteractionCard interaction={interaction as never} />
  </ThemeProvider></TooltipProvider></QueryClientProvider>));

  it("keeps the question's context readable under the receipt", async () => {
    await paint(withContext("**Contexte** de la décision\n\n- point un\n- point deux"));
    expect(host.querySelector(".coordinator-decision-receipt")).not.toBeNull();
    const context = host.querySelector('[data-testid="answered-question-context"]');
    expect(context?.querySelector("summary")?.textContent).toBe("Question context");
    expect(context?.querySelector("strong")?.textContent).toBe("Contexte");
    expect([...context!.querySelectorAll("li")].map((item) => item.textContent?.trim())).toEqual(["point un", "point deux"]);
  });

  it("shows the bare receipt when the question had no context", async () => {
    await paint(withContext());
    expect(host.querySelector(".coordinator-decision-receipt")).not.toBeNull();
    expect(host.querySelector('[data-testid="answered-question-context"]')).toBeNull();
  });

  it("renders the resolved receipt's question and help text as Markdown", async () => {
    const base = withContext("**Contexte**");
    const interaction = { ...base, payload: { ...base.payload, questions: base.payload.questions.map((question, index) =>
      index === 0 ? { ...question, helpText: "voir *aussi* la note" } : question) } };
    interaction.payload.questionSet!.questions = interaction.payload.questionSet!.questions.map((question, index) =>
      index === 0 ? { ...question, helpText: "voir *aussi* la note" } : question);
    await act(() => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
      <TaskChatCompactInteractionCard interaction={interaction as never} presentation="takeover" />
    </ThemeProvider></TooltipProvider></QueryClientProvider>));
    expect([...host.querySelectorAll("em")].some((element) => element.textContent === "aussi")).toBe(true);
    expect(host.textContent).not.toContain("*aussi*");
  });
});
