#!/usr/bin/env node
// Entry point: `node dist/index.js` speaks MCP over stdin/stdout.
// IMPORTANT: stdout belongs to the protocol. Never console.log here -- logs go to stderr.

import { Bank, defaultDataDir } from "./data.js";
import { McpServer } from "./protocol.js";
import { serveStdio } from "./stdio.js";
import { buildTools } from "./tools.js";

const log = (message: string): void => {
  process.stderr.write(`[interview-mcp] ${message}\n`);
};

async function main(): Promise<void> {
  const dir = process.env.INTERVIEW_DATA_DIR || defaultDataDir();
  const bank = Bank.load(dir);
  log(`loaded ${bank.questionCount} questions from ${bank.projects.size} projects (${dir})`);

  const server = new McpServer({
    name: "interview-mcp",
    instructions:
      "Interview question banks for 10 backend projects plus cross-project system design. " +
      "Start with list_projects. Use search_questions to find ids, get_question for full answers, " +
      "random_questions for quizzes, and get_pitch for project explanations. Answers are written in Hinglish.",
    tools: buildTools(bank),
    log,
  });

  process.stdout.on("error", () => process.exit(0)); // client went away (EPIPE): nothing left to do
  await serveStdio(server, process.stdin, process.stdout);
}

main().catch((e: unknown) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
