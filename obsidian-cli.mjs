import { execFile } from "node:child_process";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getVaultPaths, internals as noteStoreInternals } from "./note-store.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_CLI_PATH = "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function cliPath() {
  return process.env.OBSIDIAN_CLI_PATH || DEFAULT_CLI_PATH;
}

function useFilesystemBackend() {
  return process.env.OBSIDIAN_BACKEND === "filesystem";
}

function normalizeFolder(folder) {
  const value = String(folder || "").replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "");
  if (!value) return "";
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Небезопасная папка Obsidian заблокирована.");
  }
  return parts.join("/");
}

async function runCli(command, parameters = []) {
  try {
    const { stdout } = await execFileAsync(cliPath(), [command, ...parameters], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 20_000,
    });
    return stdout.trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`Obsidian CLI не выполнил команду: ${detail}`);
  }
}

async function listMarkdownFiles(folder = "") {
  const paths = getVaultPaths();
  const rootRealPath = await realpath(paths.root);
  const requestedStart = path.resolve(paths.root, ...folder.split("/").filter(Boolean));
  const start = await realpath(requestedStart);
  if (start !== rootRealPath && !start.startsWith(`${rootRealPath}${path.sep}`)) {
    throw new Error("Выход за пределы хранилища Obsidian заблокирован.");
  }

  const results = [];
  async function visit(directory) {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name, "ru"));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".md")) {
        results.push(path.relative(rootRealPath, absolute).split(path.sep).join("/"));
      }
    }
  }

  await visit(start);
  return results;
}

function normalizeQuery(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ru-RU").trim();
}

function parseCliJsonArray(output) {
  const value = String(output || "").trim();
  if (!value || /^no matches found\.?$/i.test(value)) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Obsidian CLI вернул результат неожиданного формата.");
  return parsed;
}

async function filesystemSearch({ query, folder, limit }) {
  const paths = getVaultPaths();
  const normalizedQuery = normalizeQuery(query);
  const files = await listMarkdownFiles(folder);
  const results = [];

  for (const relativePath of files) {
    if (results.length >= limit) break;
    const absolute = path.join(paths.root, ...relativePath.split("/"));
    const content = await readFile(absolute, "utf8");
    if (content.length > 2_000_000) continue;
    const matches = [];
    const filenameMatches = normalizeQuery(relativePath).includes(normalizedQuery);
    for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
      if (normalizeQuery(line).includes(normalizedQuery)) {
        matches.push({ line: index + 1, text: line.slice(0, 2_000) });
        if (matches.length >= 20) break;
      }
    }
    if (filenameMatches && !matches.length) matches.push({ line: 0, text: `[имя файла] ${relativePath}` });
    if (matches.length) results.push({ file: relativePath, matches });
  }

  return results;
}

export async function checkCli() {
  if (useFilesystemBackend()) {
    const noteCount = (await listMarkdownFiles()).length;
    return { ready: true, noteCount, cli: "filesystem-index" };
  }
  const output = await runCli("files", ["ext=md", "total"]);
  const noteCount = Number.parseInt(output, 10);
  if (!Number.isFinite(noteCount)) throw new Error("Obsidian CLI вернул неизвестный результат.");
  return { ready: true, noteCount, cli: "official-obsidian-cli" };
}

export async function searchNotes(raw = {}) {
  const query = String(raw.query || "").trim();
  if (!query) throw new Error("Нужно указать поисковый запрос.");
  if (Array.from(query).length > 300) throw new Error("Поисковый запрос слишком длинный.");

  const limit = Math.min(50, Math.max(1, Number.parseInt(raw.limit || 10, 10)));
  const folder = normalizeFolder(raw.folder);
  if (useFilesystemBackend()) {
    const results = await filesystemSearch({ query, folder, limit });
    return { query, folder, results };
  }
  const parameters = [`query=${query}`, `limit=${limit}`, "format=json"];
  if (folder) parameters.push(`path=${folder}`);

  const output = await runCli("search:context", parameters);
  const results = parseCliJsonArray(output);
  return { query, folder, results };
}

export async function listNotes(raw = {}) {
  const folder = normalizeFolder(raw.folder);
  const limit = Math.min(500, Math.max(1, Number.parseInt(raw.limit || 100, 10)));
  if (useFilesystemBackend()) {
    const allPaths = await listMarkdownFiles(folder);
    return { folder, paths: allPaths.slice(0, limit), total: allPaths.length, truncated: allPaths.length > limit };
  }
  const parameters = ["ext=md"];
  if (folder) parameters.push(`folder=${folder}`);

  const output = await runCli("files", parameters);
  const allPaths = output ? output.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  return { folder, paths: allPaths.slice(0, limit), total: allPaths.length, truncated: allPaths.length > limit };
}

export async function getOutline(relativePath) {
  if (useFilesystemBackend()) {
    const paths = getVaultPaths();
    const safeRelativePath = noteStoreInternals.normalizeRelativeNotePath(relativePath);
    const absolute = path.join(paths.root, ...safeRelativePath.split("/"));
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Путь не является обычной Markdown-заметкой.");
    const content = await readFile(absolute, "utf8");
    const headings = noteStoreInternals.parseHeadings(content).headings.map(({ level, heading, index }) => ({
      level,
      heading,
      line: index + 1,
    }));
    return { relativePath: safeRelativePath, headings };
  }
  const output = await runCli("outline", [`path=${relativePath}`, "format=json"]);
  return { relativePath, headings: output ? JSON.parse(output) : [] };
}

export const internals = { listMarkdownFiles, normalizeFolder, normalizeQuery, parseCliJsonArray };
