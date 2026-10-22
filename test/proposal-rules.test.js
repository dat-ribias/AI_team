import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';

const projectRules = "PROPOSAL_PROJECT_RULE $$ $& $' $`\n";
const systemRules = "PROPOSAL_SYSTEM_RULE $$ $& $' $`";
const memberRules = "PROPOSAL_MEMBER_RULE $$ $& $' $`";
const occurrences = (text, value) => text.split(value).length - 1;
const digest = text => createHash('sha256').update(text).digest('hex');

function assertAuthorityContract(prompt) {
  const authority = prompt.split('\n').find(line => /controller/i.test(line) && /(permission|capabilit)/i.test(line) && /(cannot|must not|never)/i.test(line));
  assert(authority, 'missing explicit controller permission ceiling');
  for (const source of ['project', 'member', 'skill', 'memory']) assert.match(authority, new RegExp(source, 'i'));
  const data = prompt.split('\n').find(line => /memory/i.test(line) && /report/i.test(line) && /web/i.test(line) && /data/i.test(line));
  assert(data, 'missing explicit memory/report/web data boundary');
}

function assertRuleEvent(event, call, rules) {
  assert(event, `missing RULE_CONTEXT for ${call.task.id}`);
  assert.equal(event.details.schemaVersion, 1);
  assert.equal(event.details.provider, call.provider);
  assert.equal(event.details.stage, call.task.stage);
  assert.equal(event.details.promptChars, call.prompt.length);
  assert.equal(event.details.promptHash, digest(call.prompt));
  for (const [kind, text] of Object.entries(rules)) {
    const source = event.details.sources.find(item => item.kind === kind);
    assert(source, `missing ${kind} source`);
    assert.equal(typeof source.source, 'string');
    assert.notEqual(source.source, '');
    assert(source.version !== undefined && source.version !== null);
    assert.equal(source.hash, digest(text));
    assert(['controller_injected', 'cli_expected'].includes(source.delivery));
    if (source.delivery === 'cli_expected') assert.equal(source.verified, false);
  }
}

async function fixture(t, provider, promptSelfRead) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-proposal-rules-'));
  const path = join(root, 'repo'), data = join(root, 'data'), home = join(root, 'home');
  mkdirSync(path); mkdirSync(data); mkdirSync(home);
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'package.json'), '{"scripts":{"start":"node server.js"}}\n', 'utf8');
  writeFileSync(join(path, 'AGENTS.md'), projectRules, 'utf8');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const agent = { id: 'lead', label: 'lead', role: 'manager', provider, systemPrompt: memberRules, ...(provider === 'antigravity' ? {} : { home }) };
  const config = {
    demo: false,
    language: 'vi',
    ...(promptSelfRead ? { promptSelfRead } : {}),
    agents: [agent],
    pipeline: { manager: 'lead', builders: ['lead'], reviewer: 'lead', verifier: 'lead' },
    projects: [{ id: 'test', path, tests: [], access: { folders: [], network: [], repos: [], paths: [{ path: 'test', grant: { lead: 'read' } }], shell: [] } }],
  };
  const calls = [];
  const team = new Team(config, data, {
    readQuota: async () => ({ observed: true, buckets: [] }),
    runAgent: async (calledAgent, task, prompt) => {
      if (task.promptFile) assert.equal(readFileSync(join(task.worktree, task.promptFile), 'utf8'), prompt);
      calls.push({ agent: calledAgent, provider: calledAgent.provider, task, prompt });
      if (task.goal === 'access proposal') return { summary: 'Đã đề xuất quyền.', folders: [], network: { members: [], why: 'Không cần mạng.' }, repos: [], paths: [], shell: [], notes: [] };
      return { summary: 'Đã đề xuất bản xem trước.', draft: { command: 'node server.js --port {port}', readyPath: '/', routes: [{ name: 'home', path: '/' }], timeoutSec: 120, ttlMin: 30 }, notes: [] };
    },
  });
  team.closed = true;
  team.setSystemPrompt(systemRules);
  t.after(async () => {
    await team.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { team, config, calls };
}

for (const provider of ['codex', 'claude', 'gemini', 'antigravity']) {
  test(`rule contract: access and preview proposals receive shared rules and policy (${provider})`, async t => {
    const f = await fixture(t, provider);
    const before = structuredClone(f.config.projects[0]);
    const access = await f.team.proposeAccess('test');
    assert.equal(access.summary, 'Đã đề xuất quyền.');
    assert.deepEqual(f.config.projects[0], before);
    const preview = await f.team.proposePreview('test');
    assert.equal(preview.summary, 'Đã đề xuất bản xem trước.');
    assert.deepEqual(f.config.projects[0], before);
    assert.equal(f.calls.length, 2);

    for (const call of f.calls) {
      const selfRead = provider === 'codex';
      assert.equal(occurrences(call.prompt, systemRules), 1);
      assert.equal(occurrences(call.prompt, memberRules), 1);
      assert.equal(occurrences(call.prompt, projectRules), selfRead ? 0 : 1);
      assert.match(call.prompt, /Return ONLY valid JSON:/);
      assert.match(call.prompt, /read-only/i);
      assertAuthorityContract(call.prompt);
      assert(!call.prompt.includes('rules above'), 'rule conflicts must name the controller authority explicitly');
      assert.equal(call.task.stage, 'plan');
      assert.equal(call.task.kind, 'research');
      assert.equal(call.task.network, false);
      assert.deepEqual(call.task.checks, []);
      assert.equal(Boolean(call.task.promptFile), ['gemini', 'antigravity'].includes(provider));
      if (call.task.goal === 'access proposal') {
        assert.match(call.prompt, /least privilege/i);
        assert.match(call.prompt, /folders/);
        assert.match(call.prompt, /network/);
      } else {
        assert.match(call.prompt, /do not edit files or start servers/i);
        assert.match(call.prompt, /"command":"command with \{port\}"/);
      }
      const event = f.team.events(call.task.id).filter(item => item.type === 'RULE_CONTEXT').at(-1);
      assertRuleEvent(event, call, { system: systemRules, member: memberRules, project: projectRules });
      const source = event.details.sources.find(item => item.kind === 'project');
      assert.equal(source.delivery, selfRead ? 'cli_expected' : 'controller_injected');
      if (selfRead) assert.equal(source.verified, false);
      else assert.notEqual(source.verified, false);
    }
  });
}

test('rule contract: proposal self-reading override is audited without claiming controller injection', async t => {
  const f = await fixture(t, 'claude', ['claude']);
  await f.team.proposeAccess('test');
  await f.team.proposePreview('test');
  for (const call of f.calls) {
    assert.equal(occurrences(call.prompt, projectRules), 0);
    const event = f.team.events(call.task.id).filter(item => item.type === 'RULE_CONTEXT').at(-1);
    assertRuleEvent(event, call, { system: systemRules, member: memberRules, project: projectRules });
    const source = event.details.sources.find(item => item.kind === 'project');
    assert.equal(source.delivery, 'cli_expected');
    assert.equal(source.verified, false);
    assert.notEqual(source.delivery, 'controller_injected');
  }
});
