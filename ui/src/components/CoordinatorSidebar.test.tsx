// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionFeed, AttentionItem } from "@paperclipai/shared";
import { buildPinnedNavigationItems, buildPluginMoreDestinations, CoordinatorSidebar } from "./CoordinatorSidebar";
import type { PluginUiContribution } from "@/api/plugins";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ attention: vi.fn(), summary: vi.fn(), openNewIssue: vi.fn(), pathname: "/COO/issues", collapsed: false, userId: "reviewer", chats: [] as Array<{ isUnreadForMe: boolean }>,
  recentTasks: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>>, projectTasks: vi.fn(), enableCases: false, agents: [] as Agent[],
  // What GET /plugins/ui-contributions answers: the declarations of the plugins that are ready, or a failure.
  contributions: [] as unknown[], contributionsFail: false }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: fixture.userId, agents: { data: fixture.agents }, chats: { data: fixture.chats }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: fixture.recentTasks }) }));
vi.mock("@/api/issues", () => ({ issuesApi: { listCompact: fixture.projectTasks } }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: fixture.openNewIssue }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: fixture.collapsed, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/attention", () => ({ attentionApi: { list: fixture.attention, summary: fixture.summary } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableCases: fixture.enableCases }) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => fixture.projects } }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { listUiContributions: async () => {
  if (fixture.contributionsFail) throw new Error("server unreachable");
  return fixture.contributions;
} } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: fixture.pathname, search: "" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

const pending = (id: string) => ({ id, sourceKind: "issue_thread_interaction", subject: { id, kind: "interaction", status: "pending" },
  createdAt: "2026-10-20T12:00:00Z", activityAt: "2026-10-20T12:00:00Z" }) as AttentionItem;
function feed(items: AttentionItem[]): AttentionFeed {
  return { companyId: "company", generatedAt: "2026-10-27T12:00:00Z", totalCount: items.length, deskBadgeCount: 0,
    nextCursor: null, countsBySourceKind: {} as AttentionFeed["countsBySourceKind"], items };
}

function summary(items: AttentionItem[]) {
  const { items: _items, nextCursor: _cursor, ...counts } = feed(items);
  return counts;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); fixture.collapsed = false; fixture.userId = "reviewer"; fixture.pathname = "/COO/issues";
  fixture.chats = []; fixture.recentTasks = []; fixture.projects = []; fixture.enableCases = false; fixture.agents = [];
  fixture.contributions = []; fixture.contributionsFail = false;
  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator task creation", () => {
  it("keeps every recent entry below the section header instead of truncating at twelve", async () => {
    fixture.recentTasks = Array.from({ length: 20 }, (_, index) => ({
      id: `task-${index}`, companyId: "company", identifier: `TASK-${index}`, title: `Recent task ${index}`, status: "todo", recordedAt: index,
    }));
    await renderSidebar();
    const region = container.querySelector('[role="region"][aria-label="Recents"]')!;
    expect(region.querySelectorAll("a")).toHaveLength(20);
    expect(region.textContent).not.toContain("Recents");
    expect(region.querySelector('a[href="/issues/TASK-0"]')).not.toBeNull();
  });
  it.each([false, true])("opens global search from the organization header when collapsed is %s", async collapsed => {
    fixture.collapsed = collapsed;
    await renderSidebar();
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    try {
      const button = container.querySelector<HTMLButtonElement>('.design-sidebar-brand button[aria-label="Global search"]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ key: "k", metaKey: true }));
    } finally { document.removeEventListener("keydown", listener); }
  });
  it.each([false, true])("opens the task form from New task above Chat when collapsed is %s", async (collapsed) => {
    fixture.collapsed = collapsed;
    await renderSidebar();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New task"]');
    const chat = container.querySelector('a[href="/chats"]');
    expect(button).not.toBeNull();
    expect(chat).not.toBeNull();
    expect(button!.compareDocumentPosition(chat!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(fixture.openNewIssue).not.toHaveBeenCalled();
    await act(async () => button!.click());
    expect(fixture.openNewIssue).toHaveBeenCalledOnce();
  });
});

describe("Coordinator pinned pages", () => {
  it("builds hundreds of agent pins with input reads proportional to list size", () => {
    const agents = Array.from({ length: 500 }, (_, index) => ({ id: `agent-${index}`, companyId: "company", name: `Agent ${index}`, urlKey: `agent-${index}` } as Agent));
    const pins = agents.map(agent => `agent-chat:company:${agent.id}`).reverse();
    let reads = 0;
    function bounded<T>(items: T[]) {
      return new Proxy(items, { get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && ++reads > 4 * agents.length) throw new Error("Pin construction scans growing lists repeatedly");
        return Reflect.get(target, property, receiver);
      } });
    }
    const items = buildPinnedNavigationItems(bounded(pins), bounded(agents), []);
    expect(items.map(item => item.key)).toEqual(pins);
    expect(reads).toBeLessThanOrEqual(4 * agents.length);
    expect(items[0].to).toBe("/chats/agent-499");
  });
  it("keeps mixed pins in stored order and prevents native link dragging", async () => {
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    const saved = ["agent-chat:company:cto", "agent-chat:another-company:hidden", "/artifacts", "/dashboard"];
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(saved));
    await renderSidebar();
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".design-sidebar-pins a")];
    expect(links.map(link => link.textContent)).toEqual(["CTO", "Artifacts", "Dashboard"]);
    expect(JSON.parse(localStorage.getItem("paperclip.coordinator.pinned-nav.v1:reviewer")!)).toEqual(saved);
    const nativeDrag = new Event("dragstart", { bubbles: true, cancelable: true });
    act(() => links[1].dispatchEvent(nativeDrag));
    expect(nativeDrag.defaultPrevented).toBe(true);
  });
  it.each([false, true])("keeps Cases reachable in More only when enabled (%s)", async enabled => {
    fixture.enableCases = enabled;
    await renderSidebar();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More workspace pages"]')!.click());
    expect(document.querySelector('a[href="/cases"]') !== null).toBe(enabled);
  });
  it("announces unread chat totals in expanded and collapsed navigation", async () => {
    fixture.chats = [{ isUnreadForMe: true }, { isUnreadForMe: false }, { isUnreadForMe: true }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"] [aria-label="2 unread chats"]')).not.toBeNull();
    fixture.collapsed = true;
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"]')?.getAttribute("aria-label")).toBe("Chat, 2 unread chats");
  });
  const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
  const pinnedPage = (to: string) => navigation().querySelector(`a[href="${to}"]`);
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }

  it.each([false, true])("restores and unpins pages in the Pinned section when collapsed is %s", async collapsed => {
    fixture.collapsed = collapsed;
    await renderSidebar();
    expect(pinnedPage("/projects")).toBeNull();
    await click("More workspace pages");
    expect(document.activeElement).toBe(document.querySelector('[data-slot="popover-content"]'));
    await click("Pin Projects");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(pinnedPage("/projects")?.textContent).toBe("Projects");
    expect(navigation().querySelector('[aria-label="Pinned pages"]')).toBeNull();
    if (!collapsed) expect(navigation().querySelector('[data-slot="sidebar-group-label"]')?.textContent).toBe("Pinned");
    const more = navigation().querySelector('button[aria-label="More workspace pages"]')!;
    expect(more.compareDocumentPosition(pinnedPage("/projects")!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(pinnedPage("/projects")).not.toBeNull();
    if (collapsed) await click("More workspace pages");
    await click("Unpin Projects");
    expect(pinnedPage("/projects")).toBeNull();
  });

  it("keeps pins personal and only renders known destinations", async () => {
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["/routines", "/projects", "/unknown", "https://example.com"]));
    await renderSidebar();
    expect(Array.from(navigation().querySelectorAll("a")).map(link => link.getAttribute("href")))
      .toEqual(["/chats", "/issues", "/decisions", "/routines", "/projects"]);
    fixture.userId = "other-user";
    await renderSidebar();
    expect(pinnedPage("/projects")).toBeNull();
    fixture.userId = "reviewer";
    await renderSidebar();
    expect(pinnedPage("/projects")?.textContent).toBe("Projects");
  });

  it("reflects pins changed in another browser tab", async () => {
    await renderSidebar();
    const key = "paperclip.coordinator.pinned-nav.v1:reviewer";
    await act(async () => {
      localStorage.setItem(key, JSON.stringify(["/agents/all"]));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(pinnedPage("/agents/all")?.textContent).toBe("Agents");
  });
});

// STUDIO-0081. The owner, 20 Nov 2026: the pages offered behind "More" can be pinned, and "Machines" must be one of
// them. "Machines" is a page of the worker router plugin, declared exactly as below in its manifest (0.30.21 and
// later); the left menu of the coordinator view mounted no plugin entry at all.
describe("Coordinator plugin pages in More (STUDIO-0081)", () => {
  const slot = (patch: Record<string, unknown>) => ({ id: "slot", displayName: "Slot", exportName: "Slot", ...patch });
  const contribution = (pluginKey: string, slots: Array<Record<string, unknown>>) =>
    ({ pluginId: `id-${pluginKey}`, pluginKey, displayName: pluginKey, version: "1.0.0", uiEntryFile: "index.js", slots, launchers: [] }) as unknown as PluginUiContribution;
  const router = contribution("paperclip-worker-router", [
    slot({ type: "page", id: "machines", displayName: "Machines", exportName: "MachinesPage", routePath: "machines" }),
    slot({ type: "sidebar", id: "machines-menu", displayName: "Machines", exportName: "MachinesMenu" }),
  ]);
  const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
  const pinnedPage = (to: string) => navigation().querySelector(`a[href="${to}"]`);
  const moreLinks = () => [...document.querySelectorAll<HTMLAnchorElement>('[aria-label="More workspace pages"][data-slot="popover-content"] a')].map(link => link.getAttribute("href"));
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }
  const KEY = "paperclip.coordinator.pinned-nav.v1:reviewer";

  it("a ready plugin with a page and a menu entry adds one destination, named as its menu entry, to its route", async () => {
    fixture.contributions = [router];
    await renderSidebar();
    // Not in the navigation itself: only behind "More".
    expect(pinnedPage("/machines")).toBeNull();
    await click("More workspace pages");
    const link = document.querySelector<HTMLAnchorElement>('[data-slot="popover-content"] a[href="/machines"]');
    expect(link?.textContent).toBe("Machines");
    // After every built-in page, behind a separator of its own.
    expect(moreLinks()).toEqual(["/search", "/dashboard", "/projects", "/routines", "/artifacts", "/agents/all", "/skills", "/apps", "/activity", "/settings", "/machines"]);
    expect(link!.closest("div")!.parentElement!.querySelector('[role="separator"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Pin Machines"]')).not.toBeNull();
  });

  it("with Cases enabled the plugin pages still come last, behind a separator of their own", async () => {
    fixture.enableCases = true;
    fixture.contributions = [router];
    await renderSidebar();
    await click("More workspace pages");
    expect(moreLinks().slice(-3)).toEqual(["/settings", "/cases", "/machines"]);
    const content = document.querySelector('[aria-label="More workspace pages"][data-slot="popover-content"]')!;
    // Before Agents, before Cases, before the plugin pages.
    expect(content.querySelectorAll('[role="separator"]')).toHaveLength(3);
    const machinesRow = content.querySelector('a[href="/machines"]')!.closest("div")!.parentElement!;
    expect(machinesRow.querySelector('[role="separator"]')).not.toBeNull();
  });

  it.each([
    ["no plugin is installed", []],
    ["the plugin is not ready (the server lists ready plugins only)", []],
    ["the plugin has a page but no menu entry", [contribution("page-only", [slot({ type: "page", routePath: "machines", displayName: "Machines" })])]],
    ["the plugin has a menu entry but no page", [contribution("menu-only", [slot({ type: "sidebar", displayName: "Machines" })])]],
    ["the plugin's page has no route", [contribution("no-route", [slot({ type: "page", displayName: "Machines" }), slot({ type: "sidebar", displayName: "Machines" })])]],
  ] as Array<[string, PluginUiContribution[]]>)("adds nothing when %s", async (_name, contributions) => {
    fixture.contributions = contributions;
    await renderSidebar();
    await click("More workspace pages");
    expect(moreLinks()).toEqual(["/search", "/dashboard", "/projects", "/routines", "/artifacts", "/agents/all", "/skills", "/apps", "/activity", "/settings"]);
    expect(document.querySelector('button[aria-label="Pin Machines"]')).toBeNull();
  });

  it("pins the plugin page by its path, shows it in Pinned, and reads the pin back", async () => {
    fixture.contributions = [router];
    await renderSidebar();
    await click("More workspace pages");
    await click("Pin Machines");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["/machines"]);
    expect(pinnedPage("/machines")?.textContent).toBe("Machines");
    // A new page load reads the pin from the browser.
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(pinnedPage("/machines")?.textContent).toBe("Machines");
    await click("More workspace pages");
    await click("Unpin Machines");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
    expect(pinnedPage("/machines")).toBeNull();
  });

  it("a pin kept while the plugin is away breaks nothing, is kept, and comes back with the plugin", async () => {
    localStorage.setItem(KEY, JSON.stringify(["/projects", "/machines", "/dashboard"]));
    await renderSidebar();
    // The plugin is absent: its pin is not shown, the others are, in their order.
    expect([...container.querySelectorAll<HTMLAnchorElement>(".design-sidebar-pins a")].map(link => link.getAttribute("href"))).toEqual(["/projects", "/dashboard"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // Pinning another page meanwhile does not drop the kept pin.
    await click("More workspace pages");
    await click("Pin Routines");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["/projects", "/machines", "/dashboard", "/routines"]);
    // The plugin is ready again: the pin is back at its place.
    fixture.contributions = [router];
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions }); });
    await flush();
    expect([...container.querySelectorAll<HTMLAnchorElement>(".design-sidebar-pins a")].map(link => link.textContent)).toEqual(["Projects", "Machines", "Dashboard", "Routines"]);
  });

  it("shows no plugin entry and no error when the server does not answer, and keeps the built-in pages", async () => {
    fixture.contributionsFail = true;
    localStorage.setItem(KEY, JSON.stringify(["/machines", "/projects"]));
    await renderSidebar();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pinnedPage("/projects")?.textContent).toBe("Projects");
    expect(pinnedPage("/machines")).toBeNull();
    await click("More workspace pages");
    expect(moreLinks()).toHaveLength(10);
  });

  it("a plugin with two menu entries and two pages gives one destination: the first of each by order", () => {
    const two = contribution("two", [
      slot({ type: "sidebar", id: "b", displayName: "Second entry", order: 20 }),
      slot({ type: "sidebar", id: "a", displayName: "Fleet", order: 10 }),
      slot({ type: "page", id: "p2", displayName: "Other page", routePath: "fleet-other", order: 2 }),
      slot({ type: "page", id: "p1", displayName: "Fleet page", routePath: "fleet", order: 1 }),
    ]);
    expect(buildPluginMoreDestinations([two], []).map(item => [item.label, item.to])).toEqual([["Fleet", "/fleet"]]);
  });

  it("gives one destination per plugin, sorted by name, and never a path a built-in page or another plugin uses", () => {
    const page = (routePath: string, label: string) => [slot({ type: "page", routePath }), slot({ type: "sidebar", displayName: label })];
    const destinations = buildPluginMoreDestinations([
      contribution("z", page("zebra", "Zebra")),
      router,
      contribution("shadow-more", page("projects", "Fake projects")),
      contribution("shadow-primary", page("issues", "Fake tasks")),
      contribution("duplicate", page("machines", "Machines again")),
    ], [{ to: "/projects" }]);
    expect(destinations.map(item => [item.label, item.to])).toEqual([["Machines", "/machines"], ["Zebra", "/zebra"]]);
    expect(buildPluginMoreDestinations(undefined, [])).toEqual([]);
  });

  it("other kinds of slots are not destinations: only a page with a menu entry", () => {
    const other = contribution("other", [
      slot({ type: "routeSidebar", routePath: "machines", displayName: "Route menu" }),
      slot({ type: "companySettingsPage", routePath: "machines", displayName: "Settings page" }),
      slot({ type: "sidebarPanel", displayName: "Panel" }),
      slot({ type: "dashboardWidget", displayName: "Widget" }),
      // It has a menu entry, but nothing of the kind "page".
      slot({ type: "sidebar", displayName: "Menu entry" }),
    ]);
    expect(buildPluginMoreDestinations([other], [])).toEqual([]);
  });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function renderSidebar() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><CoordinatorSidebar /></TooltipProvider></QueryClientProvider>));
  await flush();
}
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

describe("Coordinator Inbox badge", () => {
  it("counts every canonical outstanding decision even when none arrived today", async () => {
    // Personal page filters and completed receipts are separate cache entries.
    client.setQueryData([...coordinatorAttentionQueryKey("company"), { search: "no match" }], feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }] });
    await renderSidebar();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(client.getQueryData(coordinatorAttentionQueryKey("company"))).toBeUndefined();
    expect(fixture.summary).toHaveBeenCalledWith("company");
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
  });

  it("updates after canonical attention refreshes and removes the badge once every decision is resolved", async () => {
    await renderSidebar();
    fixture.summary.mockResolvedValue(summary([pending("review")]));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    fixture.summary.mockResolvedValue(summary([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }, { id: "accepted-review" }] });
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(decisionLink().textContent).toBe("Inbox");
  });

  it("announces the full outstanding count when the sidebar is collapsed", async () => {
    fixture.collapsed = true;
    await renderSidebar();
    expect(decisionLink().getAttribute("aria-label")).toBe("Inbox, 2 decisions");
  });
});


describe("Coordinator collection reads", () => {
  it("does not replace a resolved count with an older summary that arrives later", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, { ...summary([pending("old")]), generatedAt: "2026-10-27T12:00:00Z" }, { updatedAt: 20 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), { ...feed([]), generatedAt: "2026-10-27T12:01:00Z" }, { updatedAt: 10 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("keeps a newer resolved count when returning to a cached navigation summary", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, summary([pending("old")]), { updatedAt: 1 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), feed([]), { updatedAt: 2 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
  });

  it("reuses the page-owned complete feed on Inbox without a second summary read", async () => {
    fixture.pathname = "/COO/decisions";
    client.setQueryData(coordinatorAttentionQueryKey("company"), feed([pending("review")]));
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    await act(async () => client.setQueryData(coordinatorAttentionQueryKey("company"), feed([])));
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });
});

describe("Coordinator task status glyphs (BUG-07)", () => {
  const covered = {
    state: "covered", reason: "active_child", unresolvedBlockerCount: 1, coveredBlockerCount: 1,
    attentionBlockerCount: 0, stalledBlockerCount: 0, sampleBlockerIdentifier: "ONB-3", sampleStalledBlockerIdentifier: null,
  };
  const glyph = (href: string) => container.querySelector<SVGElement>(`a[href="${href}"] svg[role="img"]`);

  it("shows a covered-blocked recent task with the same queued glyph and label as the task pane", async () => {
    fixture.recentTasks = [{ id: "task-1", companyId: "company", identifier: "ONB-1", title: "Paperclip onboarding",
      status: "blocked", displayStatus: "blocked", externalConversationState: null, blockerAttention: covered, recordedAt: 1 }];
    await renderSidebar();
    expect(glyph("/issues/ONB-1")?.style.color).toBe("var(--status-task-icon-in_queue)");
    expect(glyph("/issues/ONB-1")?.getAttribute("aria-label")).toBe("Blocked · waiting on active sub-task ONB-3");
  });

  it("shows project tasks with their full status presentation", async () => {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    fixture.projectTasks.mockResolvedValue([
      { id: "task-1", identifier: "ONB-1", title: "Blocked parent", status: "blocked", displayStatus: "blocked", blockerAttention: covered },
      { id: "task-3", identifier: "ONB-3", title: "Waiting review", status: "in_review", displayStatus: "in_review", externalConversationState: "waiting" },
    ]);
    fixture.pathname = "/COO/projects/onboarding";
    await renderSidebar();
    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Onboarding"]');
    expect(expand).not.toBeNull();
    await act(async () => expand!.click());
    await flush();
    expect(fixture.projectTasks).toHaveBeenCalledWith("company", expect.objectContaining({ projectId: "project-1", projection: "rows" }));
    expect(glyph("/issues/ONB-1")?.style.color).toBe("var(--status-task-icon-in_queue)");
    expect(glyph("/issues/ONB-3")?.getAttribute("aria-label")).toBe("Idle");
  });
});
