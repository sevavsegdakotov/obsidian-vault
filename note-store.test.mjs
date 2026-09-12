import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendNote, internals, readNote, replaceNote, saveNote, updateNoteSection } from "./note-store.mjs";

test("creates a compliant filename within 80 characters", () => {
  const description = internals.normalizeDescription("Очень длинная — заметка: с запрещёнными / символами и деталями");
  const filename = internals.makeFilename(description, "reference", "2026-08-20");
  assert.ok(Array.from(filename).length <= 80);
  assert.equal(filename.includes("—"), false);
  assert.equal(filename.includes("/"), false);
});

test("writes only to the configured new-note folder and never overwrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-test-"));
  await mkdir(path.join(root, "personal"));
  const input = {
    title: "Тестовая заметка",
    body: "Содержимое.",
    type: "reference",
    topics: ["ideas"],
    created: "2026-08-20",
    status: "final",
    sensitive: false,
  };

  const first = await saveNote(input, root);
  const duplicate = await saveNote(input, root);
  const changed = await saveNote({ ...input, body: "Другое содержимое." }, root);

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.match(changed.filename, / версия 2 - 2026-08-20\.md$/);
  assert.equal(path.dirname(first.relativePath), ".");

  const content = await readFile(path.join(root, first.relativePath), "utf8");
  assert.doesNotMatch(content, /owner:/);
  assert.match(content, /topic\/ideas/);
});

test("medical topics are automatically sensitive", () => {
  const markdown = internals.buildMarkdown(
    {
      title: "Здоровье",
      body: "Текст.",
      type: "reference",
      status: "final",
      created: "2026-08-20",
      topics: ["health"],
      sensitive: false,
    },
    "2026-08-20",
  );
  assert.match(markdown, /sensitivity: sensitive/);
});

test("reads notes with a stable hash and blocks traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-test-"));
  await mkdir(path.join(root, "personal"));
  await writeFile(path.join(root, "personal", "sample.md"), "# Sample\n\nText.\n", "utf8");

  const note = await readNote("personal/sample.md", root);
  assert.equal(note.content, "# Sample\n\nText.\n");
  assert.equal(note.sha256.length, 64);
  await assert.rejects(() => readNote("../outside.md", root), /Небезопасный путь/);
});

test("blocks symlinked notes that escape the vault", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-outside-"));
  await mkdir(path.join(root, "personal"));
  await writeFile(path.join(outside, "secret.md"), "secret", "utf8");
  await symlink(path.join(outside, "secret.md"), path.join(root, "personal", "link.md"));
  await assert.rejects(() => readNote("personal/link.md", root), /обычной Markdown-заметкой/);
});

test("updates only when the expected hash is current", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-test-"));
  await mkdir(path.join(root, "personal"));
  await writeFile(path.join(root, "personal", "sample.md"), "# Sample\n\nOld.\n", "utf8");
  const before = await readNote("personal/sample.md", root);

  const result = await replaceNote(
    { relativePath: "personal/sample.md", body: "# Sample\n\nNew.", expectedSha256: before.sha256 },
    root,
  );
  assert.equal(result.changed, true);
  assert.equal(await readFile(path.join(root, "personal", "sample.md"), "utf8"), "# Sample\n\nNew.\n");
  await assert.rejects(
    () => appendNote({ relativePath: "personal/sample.md", content: "More.", expectedSha256: before.sha256 }, root),
    /изменилась после чтения/,
  );
});

test("updates one exact section and preserves the rest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-test-"));
  await mkdir(path.join(root, "personal"));
  const initial = "# Sample\n\nIntro.\n\n## Target\n\nOld.\n\n## Keep\n\nUntouched.\n";
  await writeFile(path.join(root, "personal", "sample.md"), initial, "utf8");
  const before = await readNote("personal/sample.md", root);

  await updateNoteSection(
    {
      relativePath: "personal/sample.md",
      heading: "Target",
      content: "New text.",
      operation: "replace",
      expectedSha256: before.sha256,
    },
    root,
  );
  const updated = await readFile(path.join(root, "personal", "sample.md"), "utf8");
  assert.match(updated, /## Target\n\nNew text\./);
  assert.match(updated, /## Keep\n\nUntouched\./);
});

test("ignores headings inside fenced code blocks", () => {
  const input = "# Real\n\n```md\n## Fake\n```\n\n## Target\n\nOld.\n";
  const output = internals.patchMarkdownSection(input, "Target", "New.", "replace");
  assert.match(output, /```md\n## Fake\n```/);
  assert.match(output, /## Target\n\nNew\./);
});
