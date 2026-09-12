import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const TIME_ZONE = process.env.OBSIDIAN_TIME_ZONE || "UTC";

export const ALLOWED_TYPES = [
  "rule",
  "guide",
  "plan",
  "process",
  "transcript",
  "summary",
  "meeting",
  "action-items",
  "research",
  "analysis",
  "report",
  "decision",
  "skill",
  "reference",
  "overview",
  "template",
  "person",
  "asset",
];

export const ALLOWED_TOPICS = [
  "health",
  "training",
  "finance",
  "learning",
  "teaching",
  "career",
  "home",
  "dacha",
  "travel",
  "work",
  "content",
  "technology",
  "purchases",
  "legal",
  "pets",
  "family",
  "ideas",
];

const ALLOWED_STATUSES = ["draft", "review", "final", "archived"];
const SENSITIVE_TOPICS = new Set(["health", "finance", "legal"]);

function yamlString(value) {
  return JSON.stringify(String(value));
}

function unicodeSlice(value, maxLength) {
  return Array.from(value).slice(0, maxLength).join("");
}

function normalizeDescription(title) {
  const normalized = String(title)
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[\\/:*?"<>|{}\[\]]/g, " ")
    .replace(/[—–]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return normalized || "заметка";
}

function localDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function makeFilename(description, type, created, suffix = "") {
  const prefix = `{${type}} `;
  const ending = `${suffix} - ${created}.md`;
  const maxDescriptionLength = 80 - Array.from(prefix + ending).length;
  const shortDescription = unicodeSlice(description, Math.max(1, maxDescriptionLength))
    .trim()
    .replace(/[. ]+$/g, "");
  return `${prefix}${shortDescription || "заметка"}${ending}`;
}

function stripLeadingFrontmatter(body) {
  const normalized = String(body).replace(/\r\n/g, "\n").trim();
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) return normalized;
  return normalized.slice(closing + 5).trim();
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeRelativeNotePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").trim().replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.length > 1_000 ||
    !normalized.toLocaleLowerCase("en-US").endsWith(".md") ||
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new Error("Небезопасный путь заметки заблокирован.");
  }
  return parts.join("/");
}

function validateExpectedSha256(value) {
  const expected = String(value || "").trim().toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("Перед обновлением нужно прочитать заметку и передать её SHA-256.");
  }
  return expected;
}

async function resolveExistingNote(relativePath, vaultRoot) {
  const safeRelativePath = normalizeRelativeNotePath(relativePath);
  const paths = getVaultPaths(vaultRoot);
  const rootRealPath = await realpath(paths.root);
  const target = path.resolve(paths.root, ...safeRelativePath.split("/"));
  const targetInfo = await lstat(target);
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
    throw new Error("Путь не является обычной Markdown-заметкой.");
  }

  const targetRealPath = await realpath(target);
  if (targetRealPath !== rootRealPath && !targetRealPath.startsWith(`${rootRealPath}${path.sep}`)) {
    throw new Error("Выход за пределы хранилища Obsidian заблокирован.");
  }

  return { target, targetInfo, relativePath: safeRelativePath };
}

function normalizeReplacementBody(body) {
  const normalized = String(body ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (!normalized.trim()) throw new Error("Обновлённый текст заметки пуст.");
  if (normalized.length > 2_000_000) throw new Error("Заметка слишком большая: максимум 2 МБ текста.");
  return `${normalized}\n`;
}

function parseHeadings(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const headings = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = lines[index].match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;

    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    const heading = match[2].replace(/\s+#+\s*$/, "").trim();
    headings.push({ index, level: match[1].length, heading });
  }

  return { lines, headings };
}

function patchMarkdownSection(markdown, rawHeading, rawContent, operation = "replace") {
  const heading = String(rawHeading || "").trim();
  const content = String(rawContent ?? "").replace(/\r\n/g, "\n").trim();
  if (!heading) throw new Error("Нужно указать точный заголовок раздела.");
  if (!content) throw new Error("Новый текст раздела пуст.");
  if (content.length > 500_000) throw new Error("Текст раздела слишком большой.");
  if (!["replace", "append", "prepend"].includes(operation)) {
    throw new Error(`Неизвестная операция с разделом: ${operation}.`);
  }

  const { lines, headings } = parseHeadings(markdown);
  const matches = headings.filter((item) => item.heading === heading);
  if (!matches.length) throw new Error(`Раздел «${heading}» не найден.`);
  if (matches.length > 1) throw new Error(`Заголовок «${heading}» встречается несколько раз; обновление остановлено.`);

  const selected = matches[0];
  const next = headings.find((item) => item.index > selected.index && item.level <= selected.level);
  const sectionEnd = next?.index ?? lines.length;
  const currentBody = lines.slice(selected.index + 1, sectionEnd).join("\n").trim();
  let nextBody = content;
  if (operation === "append" && currentBody) nextBody = `${currentBody}\n\n${content}`;
  if (operation === "prepend" && currentBody) nextBody = `${content}\n\n${currentBody}`;

  const suffix = lines.slice(sectionEnd);
  while (suffix[0] === "") suffix.shift();
  const rebuilt = [
    ...lines.slice(0, selected.index + 1),
    "",
    ...nextBody.split("\n"),
    ...(suffix.length ? ["", ...suffix] : []),
  ].join("\n").trimEnd();
  return `${rebuilt}\n`;
}

async function mutateNote({ relativePath, expectedSha256, transform }, vaultRoot) {
  const resolved = await resolveExistingNote(relativePath, vaultRoot);
  const expected = validateExpectedSha256(expectedSha256);
  const lockPath = path.join(path.dirname(resolved.target), `.${path.basename(resolved.target)}.codex.lock`);
  const tempPath = path.join(path.dirname(resolved.target), `.${path.basename(resolved.target)}.codex-${randomUUID()}.tmp`);
  let lockHandle;
  let tempHandle;

  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("Эту заметку уже обновляет другой процесс. Повторите позже.");
      throw error;
    }

    const current = await readFile(resolved.target, "utf8");
    const currentSha256 = sha256(current);
    if (currentSha256 !== expected) {
      throw new Error("Заметка изменилась после чтения. Прочитайте её заново перед обновлением.");
    }

    const next = transform(current);
    if (next === current) {
      return { changed: false, relativePath: resolved.relativePath, sha256: currentSha256, previousSha256: currentSha256 };
    }

    tempHandle = await open(tempPath, "wx", resolved.targetInfo.mode & 0o777);
    await tempHandle.writeFile(next, "utf8");
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    const latest = await readFile(resolved.target, "utf8");
    if (sha256(latest) !== expected) {
      throw new Error("Заметка изменилась во время обновления. Изменение отменено.");
    }

    await rename(tempPath, resolved.target);
    return {
      changed: true,
      relativePath: resolved.relativePath,
      sha256: sha256(next),
      previousSha256: currentSha256,
      bytes: Buffer.byteLength(next, "utf8"),
    };
  } finally {
    await tempHandle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    await lockHandle?.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function buildMarkdown(input, imported) {
  const topics = [...new Set(input.topics || [])];
  const sensitive = Boolean(input.sensitive) || topics.some((topic) => SENSITIVE_TOPICS.has(topic));
  const tags = [`type/${input.type}`, `status/${input.status}`, ...topics.map((topic) => `topic/${topic}`)];

  const lines = [
    "---",
    `title: ${yamlString(input.title)}`,
    "tags:",
    ...tags.map((tag) => `  - ${tag}`),
    `type: ${input.type}`,
    `created: ${input.created}`,
    `status: ${input.status}`,
    "source-platform: chatgpt",
  ];

  if (input.sourceProject) lines.push(`source-project: ${yamlString(input.sourceProject)}`);
  if (input.sourceChat) lines.push(`source-chat: ${yamlString(input.sourceChat)}`);
  if (input.sourceId) lines.push(`source-id: ${yamlString(input.sourceId)}`);
  lines.push(`imported: ${imported}`);
  if (sensitive) lines.push("sensitivity: sensitive");
  lines.push("---", "");

  const body = stripLeadingFrontmatter(input.body);
  if (!/^#\s+/m.test(body)) lines.push(`# ${input.title}`, "");
  lines.push(body, "");
  return lines.join("\n");
}

function normalizeInput(raw) {
  const title = String(raw.title || "").trim();
  const body = String(raw.body || "").trim();
  const type = raw.type || "reference";
  const status = raw.status || "final";
  const created = raw.created || localDate();
  const topics = raw.topics || [];

  if (!title) throw new Error("Нужно указать название заметки.");
  if (!body) throw new Error("Текст заметки пуст.");
  if (body.length > 1_000_000) throw new Error("Заметка слишком большая: максимум 1 МБ текста.");
  if (!ALLOWED_TYPES.includes(type)) throw new Error(`Недопустимый тип заметки: ${type}.`);
  if (!ALLOWED_STATUSES.includes(status)) throw new Error(`Недопустимый статус: ${status}.`);
  if (!validateDate(created)) throw new Error("Дата должна быть реальной датой в формате ГГГГ-ММ-ДД.");

  const invalidTopics = topics.filter((topic) => !ALLOWED_TOPICS.includes(topic));
  if (invalidTopics.length) {
    throw new Error(`Неизвестные темы: ${invalidTopics.join(", ")}.`);
  }

  return {
    title,
    body,
    type,
    status,
    created,
    topics,
    sensitive: raw.sensitive,
    sourceProject: raw.sourceProject?.trim() || undefined,
    sourceChat: raw.sourceChat?.trim() || undefined,
    sourceId: raw.sourceId?.trim() || undefined,
  };
}

export function getVaultPaths(vaultRoot = process.env.OBSIDIAN_VAULT_ROOT) {
  if (!vaultRoot) throw new Error("Set OBSIDIAN_VAULT_ROOT to the absolute path of the Obsidian vault.");
  const root = path.resolve(vaultRoot);
  const noteFolder = String(process.env.OBSIDIAN_NEW_NOTE_FOLDER || "")
    .replaceAll("\\", "/")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const folderParts = noteFolder ? noteFolder.split("/") : [];
  if (folderParts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("OBSIDIAN_NEW_NOTE_FOLDER contains an unsafe path.");
  }
  return { root, notes: path.join(root, ...folderParts), noteFolder };
}

export async function checkVault(vaultRoot) {
  const paths = getVaultPaths(vaultRoot);
  const rootInfo = await stat(paths.root);

  return {
    ready: rootInfo.isDirectory(),
    destination: paths.noteFolder ? `${paths.noteFolder}/` : "./",
  };
}

export async function saveNote(raw, vaultRoot) {
  const input = normalizeInput(raw);
  const paths = getVaultPaths(vaultRoot);
  const imported = localDate();
  const description = normalizeDescription(input.title);
  const markdown = buildMarkdown(input, imported);

  await mkdir(paths.notes, { recursive: true });

  for (let version = 1; version <= 99; version += 1) {
    const suffix = version === 1 ? "" : ` версия ${version}`;
    const filename = makeFilename(description, input.type, input.created, suffix);
    const target = path.join(paths.notes, filename);

    if (path.dirname(target) !== paths.notes) {
      throw new Error("Небезопасный путь заметки заблокирован.");
    }

    try {
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(markdown, "utf8");
      } finally {
        await handle.close();
      }

      const relativePath = paths.noteFolder ? `${paths.noteFolder}/${filename}` : filename;
      return {
        created: true,
        filename,
        relativePath,
        obsidianUri: `obsidian://open?vault=${encodeURIComponent(path.basename(paths.root))}&file=${encodeURIComponent(relativePath)}`,
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(target, "utf8");
      if (existing === markdown) {
        const relativePath = paths.noteFolder ? `${paths.noteFolder}/${filename}` : filename;
        return {
          created: false,
          filename,
          relativePath,
          obsidianUri: `obsidian://open?vault=${encodeURIComponent(path.basename(paths.root))}&file=${encodeURIComponent(relativePath)}`,
        };
      }
    }
  }

  throw new Error("Не удалось подобрать свободное имя заметки.");
}

export async function readNote(relativePath, vaultRoot) {
  const resolved = await resolveExistingNote(relativePath, vaultRoot);
  const [content, info] = await Promise.all([readFile(resolved.target, "utf8"), stat(resolved.target)]);
  if (content.length > 2_000_000) throw new Error("Заметка слишком большая для чтения через MCP.");
  return {
    relativePath: resolved.relativePath,
    content,
    sha256: sha256(content),
    bytes: info.size,
    modified: info.mtime.toISOString(),
  };
}

export async function replaceNote(raw, vaultRoot) {
  const nextBody = normalizeReplacementBody(raw.body);
  return mutateNote(
    {
      relativePath: raw.relativePath,
      expectedSha256: raw.expectedSha256,
      transform: () => nextBody,
    },
    vaultRoot,
  );
}

export async function appendNote(raw, vaultRoot) {
  const addition = String(raw.content ?? "").replace(/\r\n/g, "\n").trim();
  if (!addition) throw new Error("Добавляемый текст пуст.");
  if (addition.length > 500_000) throw new Error("Добавляемый текст слишком большой.");
  return mutateNote(
    {
      relativePath: raw.relativePath,
      expectedSha256: raw.expectedSha256,
      transform: (current) => `${current.trimEnd()}\n\n${addition}\n`,
    },
    vaultRoot,
  );
}

export async function updateNoteSection(raw, vaultRoot) {
  return mutateNote(
    {
      relativePath: raw.relativePath,
      expectedSha256: raw.expectedSha256,
      transform: (current) => patchMarkdownSection(current, raw.heading, raw.content, raw.operation),
    },
    vaultRoot,
  );
}

export const internals = {
  buildMarkdown,
  localDate,
  makeFilename,
  normalizeDescription,
  normalizeInput,
  normalizeRelativeNotePath,
  parseHeadings,
  patchMarkdownSection,
  sha256,
};
