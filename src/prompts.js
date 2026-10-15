import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SYSTEM_PROMPT = `Write files only as UTF-8. Never write files with PowerShell Set-Content, Out-File, or redirection (>).
Never read credentials, tokens, or auth.json.
Never commit, push, merge, publish, or change the source checkout.
Stop every process or server you start, using finally or t.after. Do not run persistent dev servers.
Change only the files and scope assigned to you.
If blocked, return status=blocked with the reason and file:line evidence.
Save logs, screenshots, and reports under .ai-team/evidence/ (git-ignored); never commit them.
Finish each call in under 25 minutes.
Always finish with the JSON report, even if a tool or command was denied.
Communicate only through the returned report; never launch or call other agents.`;

export const DEFAULT_BUDGETS = { system: 2500, project: 4000, memory: 4000, context: 30000 };
export const estimateTokens = s => Math.ceil(s.length / 4);

export function readProjectPrompt(worktree, sourcePath) {
  for (const [root, inWorktree] of [[worktree, true], [sourcePath, false]]) {
    try { return { text: readFileSync(join(root, 'AGENTS.md'), 'utf8'), inWorktree }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return null;
}
