import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { capabilitiesFor } from '../src/capabilities.js';
import { memberProtection } from '../src/providers.js';
import { Team } from '../src/team.js';

const plain = value => JSON.parse(JSON.stringify(value));

// Stub toàn bộ I/O của adapter: không chạy CLI, đọc tài khoản hay tạo server.
function adapterFixture(platform) {
  let captured;
  const source = readFileSync(new URL('../src/providers.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
  const adapter = runInNewContext(`${source}\n({ runAgent, permissionProfile })`, {
    process: { platform, env: {} }, join, capabilitiesFor, existsSync: () => true,
    childEnv: () => ({}), resolveCommand: () => ['stub-cli'], msg: key => key,
    run: async (command, args, options) => {
      captured = { args: plain(args), input: options.input };
      options.onLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"Đã kiểm tra","status":"completed"}' } }), 'stdout');
    },
  });
  return { ...adapter, captured: () => captured };
}

test('member protection keeps global configuration scoped to job, proposals and intake', () => {
  const config = { codexWindowsSandbox: 'none', agyAutoApprove: true };
  const agy = memberProtection({ provider: 'antigravity', model: 'gemini-test' }, config, 'win32');
  for (const name of ['job', 'accessProposal', 'previewProposal', 'intake']) {
    const context = agy.contexts[name];
    assert.equal(context.applicable, true);
    assert.equal(context.approval.mode, name === 'job' ? 'skip-permissions' : 'provider-settings');
    assert.equal(context.cliFlags.includes('--dangerously-skip-permissions'), name === 'job');
    assert.equal(context.settings.autoApprove.source, name === 'job' ? 'global' : 'default');
  }
  const codex = memberProtection({ provider: 'codex' }, config, 'win32');
  for (const name of ['job', 'accessProposal', 'previewProposal']) {
    assert.equal(codex.contexts[name].sandbox.mode, 'danger-full-access');
    assert.equal(codex.contexts[name].settings.windowsSandbox.source, 'global');
  }
  assert.deepEqual(codex.contexts.intake, { applicable: false, reason: 'provider-not-selected' });
  assert.equal(codex.contexts.job.scope, 'task-baseline');
  assert(codex.contexts.job.dependsOn.includes('stage'));
  assert(codex.contexts.job.dependsOn.includes('checks'));
  assert(codex.contexts.job.dependsOn.includes('network'));
  assert.equal(codex.contexts.job.inputs.stage, 'plan');
  assert.equal(codex.contexts.job.enforcement.postCheck, 'controller-stage-dependent');
  for (const name of ['accessProposal', 'previewProposal', 'intake']) assert.equal(agy.contexts[name].enforcement.postCheck, 'not-applied');
  assert.deepEqual(codex.contexts.accessProposal.globalSettings, ['codexWindowsSandbox']);
  assert.deepEqual(agy.contexts.intake.globalSettings, []);
  assert.equal(memberProtection({ provider: 'antigravity', model: 'other' }, config).contexts.intake.applicable, false);
});

test('member protection preserves member overrides and defaults in every applicable context', () => {
  for (const autoApprove of [false, true]) {
    const profile = memberProtection({ provider: 'antigravity', model: 'gemini-test', autoApprove }, { agyAutoApprove: true });
    for (const context of Object.values(profile.contexts)) {
      assert.equal(context.settings.autoApprove.source, 'agent');
      assert.equal(context.approval.mode, autoApprove ? 'skip-permissions' : 'provider-settings');
    }
  }
  const codex = memberProtection({ provider: 'codex', windowsSandbox: 'off' }, { codexWindowsSandbox: 'none' }, 'win32');
  assert.equal(codex.contexts.job.sandbox.mode, 'read-only');
  assert.equal(codex.contexts.job.settings.windowsSandbox.source, 'agent');
  const defaults = memberProtection({ provider: 'antigravity' }, {}, 'linux');
  assert.equal(defaults.contexts.job.settings.autoApprove.source, 'default');
  assert.equal(defaults.contexts.job.approval.mode, 'provider-settings');
});

test('runAgent consumes permission profile without changing Codex argv order or resume', async () => {
  for (const platform of ['win32', 'linux']) for (const windowsSandbox of [undefined, 'none', 'off', 'unelevated']) {
    const f = adapterFixture(platform);
    const agent = { id: 'test', provider: 'codex', home: 'stub-home', windowsSandbox, model: 'test-model', effort: 'medium' };
    const task = { stage: 'implement', worktree: 'stub-worktree', codexWindowsSandbox: 'none', sessionId: 'session', attachments: ['shot.png', 'note.txt'], addDirs: ['linked'], network: false };
    await f.runAgent(agent, task, 'prompt', { onEvent() {} });
    const sandbox = platform === 'win32' && (!windowsSandbox || windowsSandbox === 'none') ? 'danger-full-access' : 'workspace-write';
    assert.deepEqual(f.captured().args, [
      'exec', '-i', join(task.worktree, 'shot.png'), '--json', '--color', 'never', '-c', 'cli_auth_credentials_store="file"',
      '-c', 'approval_policy="never"', '--sandbox', sandbox, '-c', 'sandbox_workspace_write.network_access=false', '-C', task.worktree,
      '--model', 'test-model', '-c', 'model_reasoning_effort="medium"', '-c', 'features.web_search=false',
      ...(platform === 'win32' && windowsSandbox === 'unelevated' ? ['-c', 'windows.sandbox="unelevated"'] : []),
      '--add-dir', 'linked', 'resume', 'session', '-',
    ]);
    assert.equal(f.captured().input, 'prompt');
    assert.equal(f.permissionProfile(agent, task).metadata.sandbox.mode, sandbox);
  }
});

test('runAgent preserves Claude, Gemini and Antigravity permission argv with stub I/O', async () => {
  for (const provider of ['claude', 'gemini', 'antigravity']) for (const autoApprove of [undefined, false, true]) {
    const f = adapterFixture('linux'), agent = { provider, autoApprove };
    const task = { stage: 'review', worktree: 'stub-worktree', checks: [['node', '--test']], agyAutoApprove: true, sessionId: 'session' };
    await f.runAgent(agent, task, 'prompt', { onEvent() {} });
    const args = f.captured().args;
    if (provider === 'claude') {
      assert.deepEqual(args.slice(0, 7), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--tools']);
      assert.deepEqual(args.slice(-4), ['--resume', 'session', '--disallowedTools', 'WebFetch,WebSearch']);
      assert.equal(f.captured().input, 'prompt');
    } else {
      assert.deepEqual(args, ['-p', 'prompt', '--output-format', 'stream-json', ...(provider === 'gemini' ? ['--approval-mode', 'default', '--allowed-tools', 'run_shell_command(node --test)'] : autoApprove !== false ? ['--dangerously-skip-permissions'] : [])]);
      assert.equal(f.captured().input, '');
    }
  }
});

test('state adds protection metadata without account, prompt, path or MCP secrets', () => {
  const agent = { id: 'a1', provider: 'antigravity', model: 'gemini-test', home: 'PRIVATE_HOME', systemPrompt: 'PRIVATE_PROMPT', account: 'PRIVATE_ACCOUNT', command: ['PRIVATE_COMMAND'], mcp: { private: { env: { SECRET: 'PRIVATE_MCP' } } } };
  const config = { agents: [agent], projects: [], agyAutoApprove: true };
  const team = Object.assign(Object.create(Team.prototype), {
    config, gitStates: new Map(), busyAgents: () => new Set(), capacity: () => ({ start: 1 }), runningSlots: () => 0,
    jobs: () => [], sessions: () => [], decisions: () => [], speed: () => null, quota: () => ({}), remaining: () => 100,
    sampleResources: () => ({}), testLimit: () => 1, storage: () => ({}),
  });
  const state = team.state();
  assert.deepEqual(state.agents[0].protection, memberProtection(agent, config));
  const json = JSON.stringify(state.agents[0].protection);
  assert(!json.includes('PRIVATE_'));
  assert.equal(state.agents[0].protection.runtimeObserved, false);
  assert.equal(state.agents[0].protection.scope, 'member-configuration');
});
