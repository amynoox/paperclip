// STUDIO-0085: the local address of a KitWright broker carries the broker's access token in its path. The Codex MCP
// client prints the whole address in the error of a failed tool call, and that error reached run logs in clear.
// These cases use made-up values of the same form: http://127.0.0.1:<port>/p/<8 characters>/t/<32 characters>/.
// STUDIO-0098: the token is recognised by its PATH, /p/<pin>/t/<32 characters>, under any address and however its
// slashes are written; the cases of that patch are at the end of the file.
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { createAgentIdentityRedactor } from "../services/agent-identity-redaction.js";
import { createRunSecretRedactionRegistry, redactRegisteredSecretValues } from "../services/run-secret-redaction.js";

vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({ resolveVersion: async () => "" }) }));

const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const OTHER_TOKEN = "aa11bb22cc33dd44ee55ff6677889900";
const HEAD = "http://127.0.0.1:52431/p/a1b2c3d4/t/";
const ADDRESS = `${HEAD}${TOKEN}/`;
const MAC_PATH = "/Users/studio/Projects/TheRanchers/Assets/Scenes/Solo.unity";
const PC_PATH = "C:\\Users\\studio\\Projects\\TheRanchers\\Assets\\Scenes\\Solo.unity";

// The line the Codex engine writes on its output when a tool call of its MCP client fails.
function codexFailedToolCall(address: string, scenePath: string) {
  return `${JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_12", type: "mcp_tool_call", server: "kitwright", tool: "load_scene", status: "failed",
      arguments: { path: scenePath, mode: "solo" },
      error: { message: `tool call failed: transport error: error sending request for url (${address}mcp): operation timed out` },
    },
  })}\n`;
}
const masked = (text: string) => text.split(TOKEN).join(REDACTED_EVENT_VALUE).split(OTHER_TOKEN).join(REDACTED_EVENT_VALUE);
// In a page of a run log the mask keeps the length of the token, so that the reader's offsets stay exact.
const PAGE_MASK = REDACTED_EVENT_VALUE.padEnd(32, "*");
const maskedPage = (text: string) => text.split(TOKEN).join(PAGE_MASK).split(OTHER_TOKEN).join(PAGE_MASK);
const leaks = (text: string) => text.includes(TOKEN.slice(0, 4)) || text.includes(TOKEN.slice(-4));

// A registry over a database that holds no registered secret for the run: what is masked is masked by the form.
function registry() {
  const where = vi.fn(async () => [{ id: "run-1", contextSnapshot: {}, credentialConnectionName: null }]);
  return createRunSecretRedactionRegistry({ select: () => ({ from: () => ({ where }) }) } as unknown as Db);
}

describe("the address of a KitWright broker, when a run's output is written", () => {
  it("masks the token in the failed tool call the Codex MCP client writes, for a Mac path as for a PC path", () => {
    for (const scenePath of [MAC_PATH, PC_PATH]) {
      const line = codexFailedToolCall(ADDRESS, scenePath);
      const redactor = createAgentIdentityRedactor();
      const written = redactor.chunk("stdout", line) + redactor.finish("stdout");
      expect(written).toBe(masked(line));
      expect(written).toContain(`error sending request for url (${HEAD}${REDACTED_EVENT_VALUE}/mcp)`);
      expect(JSON.parse(written).item.arguments.path).toBe(scenePath);
      expect(leaks(written)).toBe(false);
    }
  });

  it("masks it in the events and in the result of a run", () => {
    const redactor = createAgentIdentityRedactor();
    const event = { eventType: "tool.failed", stream: "stdout", message: `error sending request for url (${ADDRESS}mcp)`,
      payload: { item: { error: { message: `url (${ADDRESS}mcp)` } }, tries: [ADDRESS, `${HEAD}${OTHER_TOKEN}/`] } };
    const result = { exitCode: 1, errorMessage: `transport: ${ADDRESS}`, resultJson: { stderr: `GET ${ADDRESS}status failed`, at: new Date(0) } };
    expect(redactor.redact(event)).toEqual(JSON.parse(masked(JSON.stringify(event))));
    expect(redactor.redact(result)).toEqual({ ...JSON.parse(masked(JSON.stringify(result))), resultJson: { stderr: masked(result.resultJson.stderr), at: new Date(0) } });
    expect(leaks(JSON.stringify(redactor.redact([event, result])))).toBe(false);
  });

  it("masks it when the address is cut between two chunks, at every position, on stdout and stderr interleaved", () => {
    const out = codexFailedToolCall(ADDRESS, PC_PATH);
    const err = `warning: retrying ${HEAD}${OTHER_TOKEN}/ after a timeout\n`;
    for (let cut = 1; cut < out.length; cut += 1) {
      const errCut = Math.min(err.length - 1, Math.max(1, cut - (out.indexOf(HEAD) - err.indexOf(HEAD))));
      const redactor = createAgentIdentityRedactor();
      const pieces = [
        ["stdout", redactor.chunk("stdout", out.slice(0, cut))],
        ["stderr", redactor.chunk("stderr", err.slice(0, errCut))],
        ["stdout", redactor.chunk("stdout", out.slice(cut))],
        ["stderr", redactor.chunk("stderr", err.slice(errCut))],
        ["stdout", redactor.finish("stdout")],
        ["stderr", redactor.finish("stderr")],
      ] as const;
      const joined = (stream: string) => pieces.filter(([name]) => name === stream).map(([, text]) => text).join("");
      expect(joined("stdout"), `stdout cut at ${cut}`).toBe(masked(out));
      expect(joined("stderr"), `stderr cut at ${errCut}`).toBe(masked(err));
    }
  });

  it("masks it when the address comes in three chunks, at every pair of positions inside it", () => {
    const text = `url (${ADDRESS}mcp) and again ${ADDRESS}`;
    const from = text.indexOf(HEAD);
    const to = from + ADDRESS.length;
    for (let first = from - 1; first <= to; first += 1) {
      for (let second = first + 1; second <= to + 1; second += 1) {
        const redactor = createAgentIdentityRedactor();
        const written = redactor.chunk("stdout", text.slice(0, first)) + redactor.chunk("stdout", text.slice(first, second))
          + redactor.chunk("stdout", text.slice(second)) + redactor.finish("stdout");
        expect(written, `cut at ${first} and ${second}`).toBe(masked(text));
      }
    }
  });

  it("an address interrupted by the end of the output keeps its beginning and never gives a part of the token", () => {
    const line = `error sending request for url (${ADDRESS}mcp)`;
    const tokenStart = line.indexOf(TOKEN);
    for (let cut = line.indexOf(HEAD) + 1; cut <= tokenStart + TOKEN.length; cut += 1) {
      const redactor = createAgentIdentityRedactor();
      const written = redactor.chunk("stdout", line.slice(0, cut)) + redactor.finish("stdout");
      // Up to /t/ the beginning is ordinary text and is kept; from the first character of the token on, it is hidden.
      expect(written, `ended at ${cut}`).toBe(cut <= tokenStart ? line.slice(0, cut) : `${line.slice(0, tokenStart)}${REDACTED_EVENT_VALUE}`);
    }
  });

  it("goes on masking the agent's private key, and holds for the key as before", () => {
    const key = ["-----BEGIN PRIVATE KEY-----", "MC4CAQAwBQYDK2VwBCIEIBHkq0fJm2Yd3pXc7VtQ9rLw5sNu1aZe8oGh4iKj6TyU", "-----END PRIVATE KEY-----"].join("\n");
    const text = `key ${key} then ${ADDRESS} end`;
    // The key in one chunk, as before; the address after it cut at every position.
    for (let cut = text.indexOf(HEAD); cut < text.length; cut += 1) {
      const redactor = createAgentIdentityRedactor(key);
      const written = redactor.chunk("stdout", text.slice(0, cut)) + redactor.chunk("stdout", text.slice(cut)) + redactor.finish("stdout");
      expect(written, `cut at ${cut}`).toBe(`key ${REDACTED_EVENT_VALUE} then ${HEAD}${REDACTED_EVENT_VALUE}/ end`);
    }
    const interrupted = createAgentIdentityRedactor(key);
    expect(interrupted.chunk("stdout", `x ${key.slice(0, 40)}`) + interrupted.finish("stdout")).toBe(`x ${REDACTED_EVENT_VALUE}`);
  });

  it("leaves a token the engine already masked, a token of another length and another path as they are", () => {
    const untouched = [
      // What the Claude engine writes: the token is already replaced.
      `error sending request for url (http://127.0.0.1:52431/p/a1b2c3d4/t/redacted/mcp)`,
      `${HEAD}${REDACTED_EVENT_VALUE}/mcp`,
      // Another length of the token.
      `${HEAD}${TOKEN.slice(1)}/`,
      `${HEAD}${TOKEN}0/`,
      // No pin, or a pin longer than 64 characters.
      `http://127.0.0.1:52431/p//t/${TOKEN}/`,
      `http://127.0.0.1:52431/p/${"a".repeat(65)}/t/${TOKEN}/`,
      // Another path.
      `http://127.0.0.1:52431/q/a1b2c3d4/t/${TOKEN}/`,
      `http://127.0.0.1:52431/p/a1b2c3d4/s/${TOKEN}/`,
      `http://127.0.0.1:3100/api/issues/TR-2069`,
    ];
    for (const text of untouched) {
      const redactor = createAgentIdentityRedactor();
      expect(redactor.chunk("stdout", text) + redactor.finish("stdout"), text).toBe(text);
      expect(redactor.redact({ message: text }), text).toEqual({ message: text });
      expect(redactRegisteredSecretValues(text, []), text).toBe(text);
    }
    // A token ended by something other than a slash is a token all the same.
    for (const end of [")", " ", "\"", "\n", "?x=1", ""]) {
      expect(redactRegisteredSecretValues(`${HEAD}${TOKEN}${end}`, [])).toBe(`${HEAD}${REDACTED_EVENT_VALUE}${end}`);
    }
  });
});

// A run log as the server keeps it: one JSON record per chunk and per line.
function logFile(lines: string[]) {
  return Buffer.from(lines.map((chunk, index) => `${JSON.stringify({ ts: `2026-11-20T17:50:${String(index % 60).padStart(2, "0")}.000Z`, stream: "stdout", chunk, seq: index })}\n`).join(""), "utf8");
}
// What the log route does: a page of bytes from an offset, passed through the run's redaction; the reader follows
// `nextOffset`, or the size of what it received when there is none (ui/src/components/run-log/LogViewer.tsx).
async function readByPages(file: Buffer, sizes: (page: number) => number) {
  const reads = registry();
  const pages: string[] = [];
  let offset = 0;
  for (let index = 0; offset < file.length && index < 100_000; index += 1) {
    const size = sizes(index);
    const bytes = file.subarray(offset, offset + size);
    const page = await reads.redactForRun("company-1", "run-1", {
      runId: "run-1", store: "local_file", logRef: "run-1.ndjson", content: bytes.toString("utf8"),
      ...(offset + size < file.length ? { nextOffset: offset + size } : {}),
    });
    pages.push(page.content);
    const next = page.nextOffset ?? offset + Buffer.byteLength(page.content);
    if (next <= offset) throw new Error(`the reader did not advance at offset ${offset} with a page of ${size} bytes`);
    offset = next;
  }
  return pages;
}

describe("the address of a KitWright broker, when a run is read", () => {
  const written = [
    "Démarrage du passage — état initial lu.\n",
    codexFailedToolCall(ADDRESS, PC_PATH),
    "{\"type\":\"turn.failed\"}\n",
    codexFailedToolCall(`${HEAD}${OTHER_TOKEN}/`, MAC_PATH),
    "fin\n",
  ];

  it("masks a line that was written in clear before this patch: the log, the events, the run, the lists of runs", async () => {
    const reads = registry();
    const file = logFile(written);
    const page = await reads.redactForRun("company-1", "run-1", { runId: "run-1", store: "local_file", logRef: "run-1.ndjson", content: file.toString("utf8") });
    expect(page.content).toBe(maskedPage(file.toString("utf8")));
    expect(page.content).toContain(`${HEAD}${PAGE_MASK}/mcp`);
    expect(Buffer.byteLength(page.content)).toBe(file.length);
    const events = [{ seq: 1188, message: written[1], payload: { chunk: written[1], item: { error: { message: `url (${ADDRESS}mcp)` } } } }];
    expect(await reads.redactForRun("company-1", "run-1", events)).toEqual(JSON.parse(masked(JSON.stringify(events))));
    const run = { id: "run-1", status: "failed", error: `transport: ${ADDRESS}`, stdoutExcerpt: written[1], resultJson: { stderr: ADDRESS }, createdAt: new Date(0) };
    const maskedRun = { ...run, error: masked(run.error), stdoutExcerpt: masked(run.stdoutExcerpt), resultJson: { stderr: masked(ADDRESS) } };
    expect(await reads.redactForRun("company-1", "run-1", run)).toEqual(maskedRun);
    expect(await reads.redactForRuns("company-1", [run])).toEqual([maskedRun]);
    expect(await reads.redactForIssue("company-1", "issue-1", { comments: [{ body: `seen in the log: ${ADDRESS}` }] }))
      .toEqual({ comments: [{ body: `seen in the log: ${HEAD}${REDACTED_EVENT_VALUE}/` }] });
  });

  it("no page gives a part of the token when the address is cut between two pages, at every position", async () => {
    const file = logFile(written);
    const whole = maskedPage(file.toString("utf8"));
    for (const token of [TOKEN, OTHER_TOKEN]) {
      const from = file.indexOf(HEAD.slice(0, 17), file.indexOf(token) - 40);
      const to = file.indexOf(token) + token.length + 2;
      for (let cut = from - 2; cut <= to; cut += 1) {
        const pages = await readByPages(file, (index) => (index === 0 ? cut : 256_000));
        expect(pages.join(""), `first page of ${cut} bytes`).toBe(whole);
        for (const page of pages) expect(page.includes(token.slice(0, 3)) || page.includes(token.slice(-3)), `first page of ${cut} bytes`).toBe(false);
      }
    }
  });

  it("no page gives a part of the token for any page size a reader may ask, from the size of an address up", async () => {
    const file = logFile(written);
    const whole = maskedPage(file.toString("utf8"));
    // Cuts inside the multi-byte characters of the first line are left out: they are damaged by the cut itself.
    const start = Buffer.byteLength(JSON.stringify({ ts: "2026-11-20T17:50:00.000Z", stream: "stdout", chunk: written[0], seq: 0 })) + 1;
    for (let size = 69; size <= 400; size += 1) {
      const pages = await readByPages(file, (index) => (index === 0 ? start : size));
      expect(pages.join(""), `pages of ${size} bytes`).toBe(whole);
    }
  });

  it("only a page of a run log is shortened, and only before an address that is not closed", async () => {
    const reads = registry();
    const open = `x ${HEAD}${TOKEN.slice(0, 10)}`;
    // STUDIO-0098: what is held is the path that carries the token; the scheme, the host and the port before it are
    // ordinary text and stay in the page.
    const kept = "x http://127.0.0.1:52431";
    expect(await reads.redactForRun("company-1", "run-1", { runId: "run-1", store: "local_file", logRef: "r.ndjson", content: open, nextOffset: 500 }))
      .toEqual({ runId: "run-1", store: "local_file", logRef: "r.ndjson", content: kept, nextOffset: 500 - (open.length - kept.length) });
    // The last page of a log has no next offset: the reader computes it from what it received.
    expect(await reads.redactForRun("company-1", "run-1", { runId: "run-1", store: "local_file", logRef: "r.ndjson", content: open }))
      .toEqual({ runId: "run-1", store: "local_file", logRef: "r.ndjson", content: kept });
    // A page that ends on a closed address, or on ordinary text, keeps its size.
    const closed = { runId: "run-1", store: "local_file", logRef: "r.ndjson", content: `x ${ADDRESS}mcp) y`, nextOffset: 500 };
    expect(await reads.redactForRun("company-1", "run-1", closed)).toEqual({ ...closed, content: maskedPage(closed.content) });
    // Anything else that holds a text named `content` is not a page of a log.
    const comment = { id: "c1", content: `see http://127.0.0.1:52431/p/a1b2`, nextOffset: 3 };
    expect(await reads.redactForRun("company-1", "run-1", comment)).toEqual(comment);
  });

  it("a log of several tens of megabytes, read page by page: every page is masked, and the mask costs little", async () => {
    const line = codexFailedToolCall(ADDRESS, PC_PATH);
    const filler = `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "dotnet build", aggregated_output: "x".repeat(900) } })}\n`;
    const lines: string[] = [];
    for (let index = 0; index < 34_000; index += 1) lines.push(index % 500 === 250 ? line : filler);
    const file = logFile(lines);
    expect(file.length).toBeGreaterThan(30_000_000);
    const reads = registry();
    let pages = 0;
    let found = 0;
    let offset = 0;
    let decoding = 0;
    let redaction = 0;
    let leaked = false;
    while (offset < file.length) {
      const before = performance.now();
      const content = file.subarray(offset, offset + 256_000).toString("utf8");
      const decoded = performance.now();
      const page = await reads.redactForRun("company-1", "run-1", {
        runId: "run-1", store: "local_file", logRef: "run-1.ndjson", content,
        ...(offset + 256_000 < file.length ? { nextOffset: offset + 256_000 } : {}),
      });
      decoding += decoded - before;
      redaction += performance.now() - decoded;
      leaked ||= leaks(page.content);
      found += page.content.split(`${HEAD}${PAGE_MASK}/mcp`).length - 1;
      offset = page.nextOffset ?? offset + Buffer.byteLength(page.content);
      pages += 1;
    }
    // Printed before the checks, so that the same case run on a tree without the mask gives the time without it.
    console.log(`STUDIO-0085 timing: ${(file.length / 1_000_000).toFixed(1)} MB, ${pages} pages of 256 kB, `
      + `${(redaction / pages).toFixed(3)} ms a page through the run's redaction, ${(decoding / pages).toFixed(3)} ms a page to decode it`);
    expect(leaked).toBe(false);
    expect(found).toBe(68);
    expect(offset).toBe(file.length);
    expect(redaction / pages).toBeLessThan(50);
  }, 120_000);
});

// STUDIO-0098. Production, 23 Nov 2026 (TR-2598): the token of a KitWright address is the Unity project's own, and it
// is durable. The first form let it through as soon as the address was not exactly http://127.0.0.1:<port>/p/<8>/t/.
// Made-up values, each of a form the first mask left in clear.
describe("the token of a KitWright address, whatever the address and however its slashes are written", () => {
  const PATH = `/p/a1b2c3d4/t/${TOKEN}/`;
  const forms: Array<[string, string]> = [
    ["a host name", `http://localhost:52431${PATH}mcp`],
    ["another address", `http://10.0.0.5:52431${PATH}mcp`],
    ["https", `https://127.0.0.1:52431${PATH}mcp`],
    ["a web socket", `ws://127.0.0.1:52431${PATH}mcp`],
    ["the IPv6 loopback", `http://[::1]:52431${PATH}mcp`],
    ["no port", `http://127.0.0.1${PATH}mcp`],
    ["a pin of one character", `http://127.0.0.1:52431/p/7/t/${TOKEN}/mcp`],
    ["a pin of four digits", `http://127.0.0.1:52431/p/1234/t/${TOKEN}/mcp`],
    ["a pin of 64 characters", `http://127.0.0.1:52431/p/${"a1b2".repeat(16)}/t/${TOKEN}/mcp`],
    ["the path alone", `${PATH}mcp`],
    ["slashes escaped as in a JSON text", `http:\\/\\/127.0.0.1:52431${PATH.replaceAll("/", "\\/")}mcp`],
    ["slashes escaped twice (a JSON text quoted in another)", `http:\\\\\\/\\\\\\/127.0.0.1:52431${PATH.replaceAll("/", "\\\\\\/")}mcp`],
    ["percent-encoded", `http%3A%2F%2F127.0.0.1%3A52431${PATH.replaceAll("/", "%2F")}mcp`],
    ["percent-encoded in lower case", `http%3a%2f%2f127.0.0.1%3a52431${PATH.replaceAll("/", "%2f")}mcp`],
    ["a token in upper case", `http://127.0.0.1:52431/p/a1b2c3d4/t/${TOKEN.toUpperCase()}/mcp`],
  ];
  const hidden = (text: string) => !text.toLowerCase().includes(TOKEN.slice(0, 6)) && !text.toLowerCase().includes(TOKEN.slice(-6));
  const transportError = (address: string) => `tool call failed: transport error: error sending request for url (${address}): connection closed`;

  it("masks it when a run's output is written: in one chunk, in the events and in the result", () => {
    for (const [name, address] of forms) {
      const line = `${JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", status: "failed", error: { message: transportError(address) } } })}\n`;
      const redactor = createAgentIdentityRedactor();
      const written = redactor.chunk("stdout", line) + redactor.finish("stdout");
      expect(hidden(written), name).toBe(true);
      // Only the token is replaced: the line keeps everything else, and stays the JSON it was.
      expect(written.length, name).toBe(line.length - TOKEN.length + REDACTED_EVENT_VALUE.length);
      expect(JSON.parse(written).item.status, name).toBe("failed");
      expect(hidden(JSON.stringify(redactor.redact({ message: transportError(address), payload: { tries: [address] } }))), name).toBe(true);
    }
  });

  it("masks it when the text is cut between two chunks, at every position, for every form", () => {
    for (const [name, address] of forms) {
      const text = `${transportError(address)} then again ${address}\n`;
      const whole = createAgentIdentityRedactor();
      const expected = whole.chunk("stdout", text) + whole.finish("stdout");
      expect(hidden(expected), name).toBe(true);
      for (let cut = 1; cut < text.length; cut += 1) {
        const redactor = createAgentIdentityRedactor();
        const written = redactor.chunk("stdout", text.slice(0, cut)) + redactor.chunk("stdout", text.slice(cut)) + redactor.finish("stdout");
        expect(written, `${name}, cut at ${cut}`).toBe(expected);
      }
    }
  });

  it("a text interrupted by the end of the output never gives a part of the token, for every form", () => {
    for (const [name, address] of forms) {
      const line = transportError(address);
      const tokenStart = line.toLowerCase().indexOf(TOKEN);
      for (let cut = 1; cut <= tokenStart + TOKEN.length; cut += 1) {
        const redactor = createAgentIdentityRedactor();
        const written = redactor.chunk("stdout", line.slice(0, cut)) + redactor.finish("stdout");
        expect(written, `${name}, ended at ${cut}`).toBe(cut <= tokenStart ? line.slice(0, cut) : `${line.slice(0, tokenStart)}${REDACTED_EVENT_VALUE}`);
      }
    }
  });

  it("masks it when a run is read: the run, its events, a page of its log, the comments of its task", async () => {
    const reads = registry();
    for (const [name, address] of forms) {
      const run = { id: "run-1", status: "failed", error: transportError(address), stdoutExcerpt: address, resultJson: { stderr: address } };
      expect(hidden(JSON.stringify(await reads.redactForRun("company-1", "run-1", run))), name).toBe(true);
      expect(hidden(JSON.stringify(await reads.redactForRuns("company-1", [run]))), name).toBe(true);
      expect(hidden(JSON.stringify(await reads.redactForIssue("company-1", "issue-1", { comments: [{ body: `seen: ${address}` }] }))), name).toBe(true);
      const content = logFile([transportError(address)]).toString("utf8");
      const page = await reads.redactForRun("company-1", "run-1", { runId: "run-1", store: "local_file", logRef: "run-1.ndjson", content });
      expect(hidden(page.content), name).toBe(true);
      // In a page the mask keeps the length of the token: the reader's offsets stay exact.
      expect(Buffer.byteLength(page.content), name).toBe(Buffer.byteLength(content));
    }
  });

  it("no page of a log gives a part of the token when the text is cut between two pages, at every position, for every form", async () => {
    for (const [name, address] of forms) {
      const file = logFile(["start\n", `${transportError(address)}\n`, "end\n"]);
      const whole = (await readByPages(file, () => 256_000)).join("");
      expect(hidden(whole), name).toBe(true);
      const tokenAt = file.toString("utf8").toLowerCase().indexOf(TOKEN);
      for (let cut = tokenAt - 130; cut <= tokenAt + TOKEN.length + 2; cut += 1) {
        const pages = await readByPages(file, (index) => (index === 0 ? cut : 256_000));
        expect(pages.join(""), `${name}, first page of ${cut} bytes`).toBe(whole);
        for (const page of pages) expect(hidden(page), `${name}, first page of ${cut} bytes`).toBe(true);
      }
    }
  });

  it("a reader always advances, also with pages shorter than the path of a token", async () => {
    const file = logFile([`${transportError(forms[0]![1])}\n`]);
    for (const size of [1, 2, 3, 7, 16, 40]) {
      const pages = await readByPages(file, () => size);
      expect(Buffer.byteLength(pages.join("")), `pages of ${size} bytes`).toBe(file.length);
    }
  });

  it("leaves ordinary paths and addresses as they are", () => {
    const untouched = [
      "http://127.0.0.1:3100/api/issues/TR-2598",
      "/Users/studio/Projects/TheRanchers/Assets/p/Scenes/t/Solo.unity",
      "C:\\Users\\studio\\p\\a1b2c3d4\\t\\notes.txt",
      // 31 characters, then something that is not a character of a token.
      `/p/a1b2c3d4/t/${TOKEN.slice(0, 31)}/mcp`,
      `/p/a1b2c3d4/t/${TOKEN}0`,
      `/q/a1b2c3d4/t/${TOKEN}`,
      `/p/a1b2c3d4/s/${TOKEN}`,
      `/p/a1b2c3d4/${TOKEN}`,
      `p/a1b2c3d4/t/${TOKEN}`,
      `/p/a1b2 c3d4/t/${TOKEN}`,
    ];
    for (const text of untouched) {
      const redactor = createAgentIdentityRedactor();
      expect(redactor.chunk("stdout", text) + redactor.finish("stdout"), text).toBe(text);
      expect(redactRegisteredSecretValues(text, []), text).toBe(text);
    }
  });
});
