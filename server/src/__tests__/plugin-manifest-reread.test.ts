/**
 * STUDIO-0060: an in-place plugin upgrade re-reads the new manifest.
 *
 * Production, 15 Nov 2026: the prompt-memory plugin files were replaced in place by 0.1.2 and
 * `POST /api/plugins/:id/upgrade` answered 200, but the plugin record kept version 0.1.1. The loader imports the
 * manifest module with the file's mtime in the URL to defeat Node's module cache, and npm-packed files all carry
 * the same fixed mtime (1985-10-26): the new manifest had the URL of the module the process had already imported.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { pluginLoader } from "../services/plugin-loader.js";

const NPM_PACK_DATE = new Date("1985-10-26T08:15:00Z");

async function writePackage(root: string, version: string) {
  await mkdir(path.join(root, "dist"), { recursive: true });
  const pkg = path.join(root, "package.json");
  const manifest = path.join(root, "dist", "manifest.js");
  await writeFile(pkg, JSON.stringify({
    name: "@paperclipai/plugin-manifest-reread", version, type: "module",
    paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
  }), "utf8");
  await writeFile(manifest, `export default ${JSON.stringify({
    id: "paperclip.manifest_reread", apiVersion: 1, version, displayName: "Manifest reread fixture",
    description: "Fixture", author: "Paperclip", categories: ["automation"], capabilities: ["companies.read"],
    entrypoints: { worker: "./dist/worker.js" },
  })};\n`, "utf8");
  await writeFile(path.join(root, "dist", "worker.js"), "export {};\n", "utf8");
  // As in an npm-packed archive: every file carries the same fixed date.
  for (const file of [pkg, manifest]) await utimes(file, NPM_PACK_DATE, NPM_PACK_DATE);
}

describe("plugin manifest re-read on an in-place upgrade (STUDIO-0060)", () => {
  let root: string | null = null;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

  it("reads the replaced manifest although both versions carry the same mtime and size", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "plugin-manifest-reread-"));
    const loader = pluginLoader({} as Db, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    await writePackage(root, "0.1.1");
    expect((await loader.loadManifest(root))?.version).toBe("0.1.1");
    // Let the file system clock move on, then replace the files in place with the same length and fixed date.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writePackage(root, "0.1.2");
    expect((await loader.loadManifest(root))?.version).toBe("0.1.2");
    // An unchanged file is not imported again under a new URL.
    expect((await loader.loadManifest(root))?.version).toBe("0.1.2");
  });
});
