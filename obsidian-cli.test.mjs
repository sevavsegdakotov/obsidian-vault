import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkCli, getOutline, internals, listNotes, searchNotes } from "./obsidian-cli.mjs";

test("official CLI no-match message becomes an empty result", () => {
  assert.deepEqual(internals.parseCliJsonArray("No matches found."), []);
  assert.deepEqual(internals.parseCliJsonArray(""), []);
});

test("filesystem backend searches, lists and outlines Markdown notes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-filesystem-test-"));
  await mkdir(path.join(root, "personal"));
  await writeFile(path.join(root, "personal", "хата.md"), "# Хата\n\n## Текущие задачи\n\n- [ ] Кладовка\n", "utf8");
  await writeFile(path.join(root, "personal", "ignore.txt"), "Кладовка", "utf8");
  process.env.OBSIDIAN_BACKEND = "filesystem";
  process.env.OBSIDIAN_VAULT_ROOT = root;
  context.after(() => {
    delete process.env.OBSIDIAN_BACKEND;
    delete process.env.OBSIDIAN_VAULT_ROOT;
  });

  const status = await checkCli();
  const listed = await listNotes({ folder: "personal" });
  const found = await searchNotes({ query: "кладовка", folder: "personal" });
  const outline = await getOutline("personal/хата.md");

  assert.equal(status.cli, "filesystem-index");
  assert.equal(status.noteCount, 1);
  assert.deepEqual(listed.paths, ["personal/хата.md"]);
  assert.equal(found.results[0].file, "personal/хата.md");
  assert.deepEqual(outline.headings, [
    { level: 1, heading: "Хата", line: 1 },
    { level: 2, heading: "Текущие задачи", line: 3 },
  ]);
});
