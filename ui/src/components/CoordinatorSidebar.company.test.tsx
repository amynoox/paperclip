// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";

// STUDIO-0081, the defect the bench found in a real Paperclip (20 Nov 2026): the "Machines" entry and its pin
// linked to `/machines`, which the app reads as a company named MACHINES ("Organization not found"). The other
// test file replaces the router by a stand-in that adds no company prefix, so it could not see it. Here the bar
// is mounted inside a company with the real router of the app (`@/lib/router`): its Link, its NavLink and its
// reading of the company on screen.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ contributions: [] as unknown[] }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));
vi.mock("@/components/IssueLinkQuicklook", () => ({ IssueLinkQuicklook: () => null }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: "reviewer", agents: { data: [] }, chats: { data: [] }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [] }) }));
vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({ useCoordinatorAttentionCount: () => 0 }));
vi.mock("@/api/issues", () => ({ issuesApi: { listCompact: async () => [] } }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableCases: false }) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { listUiContributions: async () => fixture.contributions } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));

// The worker router's declaration (0.30.23, manifest.js).
const router = {
  pluginId: "id-router", pluginKey: "amynoox.worker-router", displayName: "Worker Router", version: "0.30.23", uiEntryFile: "index.js", launchers: [],
  slots: [
    { type: "settingsPage", id: "settings", displayName: "Router Settings", exportName: "SettingsPage" },
    { type: "page", id: "machines", displayName: "Machines", exportName: "MachinesPage", routePath: "machines" },
    { type: "sidebar", id: "machines-menu", displayName: "Machines", exportName: "MachinesMenu" },
  ],
};
const KEY = "paperclip.coordinator.pinned-nav.v1:reviewer";

// What the app's routes make of the address: `/:companyPrefix/<board page>` for the host's own pages, and
// `/:companyPrefix/:pluginRoutePath/*` for a plugin page (App.tsx). An address whose first segment is not a
// company is the "Organization not found" screen.
function Where() {
  const params = useParams();
  const location = useLocation();
  return <output data-testid="where">{JSON.stringify({ pathname: location.pathname, companyPrefix: params.companyPrefix ?? null, pluginRoutePath: params.pluginRoutePath ?? null })}</output>;
}
function App({ start }: { start: string }) {
  return <MemoryRouter initialEntries={[start]}>
    <Routes>
      <Route path=":companyPrefix/*" element={<><CoordinatorSidebar /><Routes>
        <Route path="chats/*" element={<Where />} />
        <Route path="projects/*" element={<Where />} />
        <Route path=":pluginRoutePath/*" element={<Where />} />
      </Routes></>} />
    </Routes>
  </MemoryRouter>;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  localStorage.clear(); fixture.contributions = [router];
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(start: string) {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><App start={start} /></TooltipProvider></QueryClientProvider>));
  await flush();
}
async function click(element: Element | null | undefined, what: string) {
  expect(element, what).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  await flush();
}
const where = () => JSON.parse(container.querySelector('[data-testid="where"]')!.textContent!) as { pathname: string; companyPrefix: string | null; pluginRoutePath: string | null };
const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
const moreLink = (label: string) => [...document.querySelectorAll<HTMLAnchorElement>('[aria-label="More workspace pages"][data-slot="popover-content"] a')]
  .find(link => link.textContent === label);
const pinned = (label: string) => [...navigation().querySelectorAll<HTMLAnchorElement>(".design-sidebar-pins a")].find(link => link.textContent === label);
const openMore = () => click(document.querySelector('button[aria-label="More workspace pages"]'), "More");

describe("Coordinator plugin pages inside a company (STUDIO-0081)", () => {
  it("the Machines entry of More links to the plugin page of the company on screen, and opens it", async () => {
    await mount("/BAN/chats");
    expect(where()).toEqual({ pathname: "/BAN/chats", companyPrefix: "BAN", pluginRoutePath: null });
    await openMore();
    // A built-in page gets its prefix from the router; the plugin page carries its own.
    expect(moreLink("Projects")!.getAttribute("href")).toBe("/BAN/projects");
    expect(moreLink("Machines")!.getAttribute("href")).toBe("/BAN/machines");
    await click(moreLink("Machines"), "Machines in More");
    // The route that serves plugin pages, in the same company: not a company named MACHINES.
    expect(where()).toEqual({ pathname: "/BAN/machines", companyPrefix: "BAN", pluginRoutePath: "machines" });
  });

  it("the pin of Machines links to the same page, is stored without any company, and opens the page", async () => {
    await mount("/BAN/chats");
    await openMore();
    await click(document.querySelector('button[aria-label="Pin Machines"]'), "Pin Machines");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["/machines"]);
    expect(pinned("Machines")!.getAttribute("href")).toBe("/BAN/machines");
    await click(pinned("Machines"), "pinned Machines");
    expect(where()).toEqual({ pathname: "/BAN/machines", companyPrefix: "BAN", pluginRoutePath: "machines" });
    // On its own page the pin is still there, with the same link.
    expect(pinned("Machines")!.getAttribute("href")).toBe("/BAN/machines");
  });

  it("the same stored pin is rendered with the prefix of another company, beside a built-in pin", async () => {
    localStorage.setItem(KEY, JSON.stringify(["/projects", "/machines"]));
    await mount("/coo/chats");
    expect(pinned("Projects")!.getAttribute("href")).toBe("/COO/projects");
    expect(pinned("Machines")!.getAttribute("href")).toBe("/COO/machines");
    await click(pinned("Machines"), "pinned Machines");
    expect(where()).toMatchObject({ pathname: "/COO/machines", pluginRoutePath: "machines" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["/projects", "/machines"]);
  });
});
