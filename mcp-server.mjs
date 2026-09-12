import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { checkCli, getOutline, listNotes, searchNotes } from "./obsidian-cli.mjs";
import {
  ALLOWED_TOPICS,
  ALLOWED_TYPES,
  appendNote,
  checkVault,
  readNote,
  replaceNote,
  saveNote,
  updateNoteSection,
} from "./note-store.mjs";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/).describe("SHA-256 from the latest read_obsidian_note result.");
const mutationOutputSchema = {
  changed: z.boolean(),
  relativePath: z.string(),
  sha256: z.string(),
  previousSha256: z.string(),
  bytes: z.number().optional(),
};

export function createServer() {
  const server = new McpServer(
    { name: "obsidian-vault", version: "0.3.0" },
    {
      instructions:
        "When a question may depend on the user's tasks, plans, projects, people, decisions, or saved notes, search Obsidian and read the relevant notes before answering. Reconcile Obsidian with useful conversation context or saved memory: show Obsidian-confirmed facts as verified, memory-only facts as unverified and possibly outdated, and conflicts explicitly. Obsidian is authoritative for what is recorded and for current status until the user confirms something newer. Name source notes. Do not write remembered information without an explicit request. Prefer these tools over computer use. Before every update, read the note and pass its SHA-256. Prefer section updates or append over full replacement. Never delete or move notes.",
    },
  );

  server.registerTool(
    "check_obsidian_vault",
    {
      title: "Check Obsidian vault",
      description: "Check that the Obsidian vault and official Obsidian CLI are ready.",
      inputSchema: {},
      outputSchema: {
        ready: z.boolean(),
        destination: z.string(),
        noteCount: z.number(),
        cli: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const [vault, cli] = await Promise.all([checkVault(), checkCli()]);
      const result = { ...vault, ...cli, ready: vault.ready && cli.ready };
      return {
        structuredContent: result,
        content: [{ type: "text", text: result.ready ? "Obsidian готов к сохранению." : "Папка Obsidian не готова." }],
      };
    },
  );

  server.registerTool(
    "search_obsidian",
    {
      title: "Search Obsidian",
      description:
        "Search the whole Obsidian knowledge base with matching line context. Use it before answering questions that may depend on saved tasks, plans, projects, people, decisions, or notes. Search useful aliases, then reconcile results with relevant conversation or saved memory. Keep memory-only facts visibly unverified.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("Words, phrase, tag, or Obsidian search expression."),
        folder: z.string().max(500).optional().describe("Optional vault-relative folder such as personal or umka-projects."),
        limit: z.number().int().min(1).max(50).default(10),
      },
      outputSchema: {
        query: z.string(),
        folder: z.string(),
        results: z.array(
          z.object({
            file: z.string(),
            matches: z.array(z.object({ line: z.number(), text: z.string() })),
          }),
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const result = await searchNotes(input);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "list_obsidian_notes",
    {
      title: "List Obsidian notes",
      description: "List Markdown notes in the whole vault or one folder. Use search_obsidian when looking for content.",
      inputSchema: {
        folder: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      outputSchema: {
        folder: z.string(),
        paths: z.array(z.string()),
        total: z.number(),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const result = await listNotes(input);
      return { structuredContent: result, content: [{ type: "text", text: result.paths.join("\n") || "Заметок нет." }] };
    },
  );

  server.registerTool(
    "read_obsidian_note",
    {
      title: "Read Obsidian note",
      description:
        "Read one Markdown note by its vault-relative path. Returns the current content and SHA-256 required for every update, preventing accidental overwrites.",
      inputSchema: { relativePath: z.string().min(1).max(1_000) },
      outputSchema: {
        relativePath: z.string(),
        content: z.string(),
        sha256: z.string(),
        bytes: z.number(),
        modified: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ relativePath }) => {
      const result = await readNote(relativePath);
      return { structuredContent: result, content: [{ type: "text", text: result.content }] };
    },
  );

  server.registerTool(
    "get_obsidian_outline",
    {
      title: "Get Obsidian outline",
      description: "List headings and line numbers in one note before choosing a section to update.",
      inputSchema: { relativePath: z.string().min(1).max(1_000) },
      outputSchema: {
        relativePath: z.string(),
        headings: z.array(z.object({ level: z.number(), heading: z.string(), line: z.number() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ relativePath }) => {
      const result = await getOutline(relativePath);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result.headings, null, 2) }] };
    },
  );

  server.registerTool(
    "append_to_obsidian_note",
    {
      title: "Append to Obsidian note",
      description:
        "Append Markdown to an existing note without overwriting it. First call read_obsidian_note and pass the returned SHA-256. Fails safely if the note changed.",
      inputSchema: {
        relativePath: z.string().min(1).max(1_000),
        content: z.string().min(1).max(500_000),
        expectedSha256: sha256Schema,
      },
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const result = await appendNote(input);
      return { structuredContent: result, content: [{ type: "text", text: `Заметка обновлена: ${result.relativePath}` }] };
    },
  );

  server.registerTool(
    "update_obsidian_section",
    {
      title: "Update Obsidian section",
      description:
        "Replace, append to, or prepend to one existing Markdown section while preserving the rest of the note. Read the note first and pass its SHA-256. The heading must be exact and unique.",
      inputSchema: {
        relativePath: z.string().min(1).max(1_000),
        heading: z.string().min(1).max(300),
        content: z.string().min(1).max(500_000),
        operation: z.enum(["replace", "append", "prepend"]).default("replace"),
        expectedSha256: sha256Schema,
      },
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await updateNoteSection(input);
      return { structuredContent: result, content: [{ type: "text", text: `Раздел обновлён: ${result.relativePath}` }] };
    },
  );

  server.registerTool(
    "replace_obsidian_note",
    {
      title: "Replace Obsidian note",
      description:
        "Replace the complete content of an existing Markdown note only when a targeted section update is insufficient. Requires the SHA-256 from the latest read and fails if the note changed.",
      inputSchema: {
        relativePath: z.string().min(1).max(1_000),
        body: z.string().min(1).max(2_000_000),
        expectedSha256: sha256Schema,
      },
      outputSchema: mutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await replaceNote(input);
      return { structuredContent: result, content: [{ type: "text", text: `Заметка заменена: ${result.relativePath}` }] };
    },
  );

  server.registerTool(
    "save_note_to_obsidian",
    {
      title: "Save note to Obsidian",
      description:
        "Create a new, properly named Markdown note when the user explicitly asks to save or export something to Obsidian. The destination folder is configured by OBSIDIAN_NEW_NOTE_FOLDER. Never overwrites an existing note.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Human-readable note title in Russian."),
        body: z.string().min(1).max(1_000_000).describe("Complete final Markdown body of the note."),
        type: z.enum(ALLOWED_TYPES).default("reference").describe("Closest allowed document type."),
        topics: z.array(z.enum(ALLOWED_TOPICS)).max(4).default([]).describe("Zero to four matching personal topic tags."),
        created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First-fixation date; omit to use today."),
        status: z.enum(["draft", "review", "final", "archived"]).default("final"),
        sourceProject: z.string().max(200).optional().describe("ChatGPT project name, when known."),
        sourceChat: z.string().max(300).optional().describe("Source chat title, when known."),
        sourceId: z.string().max(300).optional().describe("Source chat identifier, when known."),
        sensitive: z.boolean().default(false).describe("Mark medical, legal, financial, or otherwise sensitive content."),
      },
      outputSchema: {
        created: z.boolean(),
        filename: z.string(),
        relativePath: z.string(),
        obsidianUri: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await saveNote(input);
      const action = result.created ? "создана" : "уже существовала";
      return {
        structuredContent: result,
        content: [{ type: "text", text: `Заметка ${action}: ${result.relativePath}` }],
      };
    },
  );

  return server;
}
