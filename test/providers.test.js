import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxArgs, claudeToolArgs, permissionProfile } from '../src/providers.js';
import { capabilitiesFor } from '../src/capabilities.js';

const option = (args, name) => args[args.indexOf(name) + 1];
const allowedTools = args => option(args, '--allowedTools').split(',');
test('Codex sandbox permits research evidence and demo networking while preserving existing stages', () => {
  assert.equal(option(sandboxArgs({ stage: 'research', kind: 'research' }), '--sandbox'), 'workspace-write');
  for (const stage of ['plan', 'review', 'verify']) assert.equal(option(sandboxArgs({ stage, kind: 'research' }), '--sandbox'), 'read-only');
  assert.equal(option(sandboxArgs({ stage: 'implement' }), '--sandbox'), 'workspace-write');
  assert.equal(option(sandboxArgs({ stage: 'implement' }, ['node --test']), '--sandbox'), 'workspace-write');
  assert.equal(option(sandboxArgs({ stage: 'review' }, ['node --test']), '--sandbox'), 'workspace-write');
  assert(sandboxArgs({ stage: 'research', kind: 'research', demoServer: { url: 'http://127.0.0.1:3334' } }).includes('sandbox_workspace_write.network_access=true'));
  assert(sandboxArgs({ stage: 'research', kind: 'research' }).includes('sandbox_workspace_write.network_access=false'));
  assert(sandboxArgs({ stage: 'plan', network: true }).includes('sandbox_workspace_write.network_access=true'));
  assert.equal(option(sandboxArgs({ stage: 'plan' }, [], false, true), '--sandbox'), 'danger-full-access');
});

test('Claude research uses default permissions and only preapproves evidence edits from the matrix', () => {
  const args = claudeToolArgs({ stage: 'research', kind: 'research' });
  assert.equal(option(args, '--permission-mode'), 'default');
  assert(option(args, '--tools').includes('Write,Edit'));
  const edits = allowedTools(args).filter(tool => /^(Write|Edit)/.test(tool));
  assert.deepEqual(edits, capabilitiesFor('research', 'builder').write.flatMap(prefix => [`Write(${prefix}**)`, `Edit(${prefix}**)`]));
  assert(!edits.includes('Write')); assert(!edits.includes('Edit'));
});

test('Claude implement keeps Edit available and preapproves only safe default test and git commands', () => {
  const declaredChecks = ['node --test test/providers.test.js', 'node -e "project-check"'];
  const args = claudeToolArgs({ stage: 'implement' }, declaredChecks, true);
  assert.equal(option(args, '--permission-mode'), 'acceptEdits');
  assert(!args.includes('--tools'));
  assert.deepEqual(allowedTools(args), [
    'Read', 'Glob', 'Grep',
    'Bash(git diff *)', 'Bash(git show *)', 'Bash(git status *)', 'Bash(git log *)', 'Bash(git grep *)',
    ...declaredChecks.flatMap(check => [`Bash(${check})`, `Bash(${check} *)`]),
    'Bash(node --test)', 'Bash(node --test *)', 'Bash(node --check *)',
    'Bash(npm test)', 'Bash(npm test *)',
  ]);

  const defaults = allowedTools(claudeToolArgs({ stage: 'implement' }));
  assert(!defaults.some(tool => tool === 'Bash' || tool === 'Bash(*)'));
  assert(!defaults.some(tool => /^Bash\(node(?: \*| -e(?: |\)))/.test(tool)));
});

test('Claude non-implement stages preserve the existing permission matrix', () => {
  const checks = ['node --test test/providers.test.js'];
  const gitReads = ['Bash(git diff *)', 'Bash(git show *)', 'Bash(git status *)', 'Bash(git log *)', 'Bash(git grep *)'];
  for (const stage of ['plan', 'review', 'verify', 'research']) {
    const writes = stage === 'research';
    const web = stage === 'review';
    const args = claudeToolArgs({ stage, kind: 'research' }, checks, web, writes);
    assert.equal(option(args, '--permission-mode'), 'default');
    assert.equal(option(args, '--tools'), `Read,Glob,Grep,Bash${writes ? ',Write,Edit' : ''}${web ? ',WebSearch,WebFetch' : ''}`);
    assert.deepEqual(allowedTools(args), [
      'Read', 'Glob', 'Grep', ...gitReads,
      ...checks.flatMap(check => [`Bash(${check})`, `Bash(${check} *)`]),
      ...(writes ? capabilitiesFor('research', 'builder').write.flatMap(prefix => [`Write(${prefix}**)`, `Edit(${prefix}**)`]) : []),
      ...(web ? ['WebSearch', 'WebFetch'] : []),
    ]);
  }
});

test('permission profile preserves Codex Windows overrides, defaults and Linux sandbox flags', () => {
  const task = { stage: 'implement', codexWindowsSandbox: 'none', network: false };
  for (const platform of ['win32', 'linux']) {
    for (const [override, expected, windows] of [
      [undefined, platform === 'win32' ? 'danger-full-access' : 'workspace-write', []],
      ['off', 'workspace-write', []], ['none', platform === 'win32' ? 'danger-full-access' : 'workspace-write', []],
      ['unelevated', 'workspace-write', platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []],
    ]) {
      const agent = { provider: 'codex', windowsSandbox: override };
      const profile = permissionProfile(agent, task, platform);
      assert.deepEqual(profile.args, ['-c', 'approval_policy="never"', '--sandbox', expected, '-c', 'sandbox_workspace_write.network_access=false']);
      assert.deepEqual(profile.windowsArgs, windows);
      assert.equal(profile.metadata.sandbox.mode, expected);
      assert.equal(profile.metadata.sandbox.network, expected === 'danger-full-access' ? 'unrestricted' : 'disabled');
      assert.equal(profile.metadata.settings.windowsSandbox.source, override ? 'agent' : 'task');
      assert.equal(profile.metadata.settings.windowsSandbox.applicable, platform === 'win32');
    }
    const defaults = permissionProfile({ provider: 'codex' }, { stage: 'plan' }, platform);
    assert.deepEqual(defaults.metadata.settings.windowsSandbox, { value: 'unelevated', source: 'default', applicable: platform === 'win32' });
    assert.equal(defaults.metadata.sandbox.mode, 'read-only');
    assert.equal(defaults.metadata.sandbox.network, 'sandbox-default');
  }
  const emptyOverride = permissionProfile({ provider: 'codex', windowsSandbox: '' }, task, 'win32');
  assert.equal(emptyOverride.metadata.sandbox.mode, 'danger-full-access');
});

test('permission profile describes stage, checks, research writes and network without treating web as isolation', () => {
  const agent = { provider: 'codex' };
  for (const [task, expected, network, web] of [
    [{ stage: 'plan' }, 'read-only', 'sandbox-default', false],
    [{ stage: 'review', checks: [['node', '--test']] }, 'workspace-write', 'disabled', false],
    [{ stage: 'verify', checks: [['npm', 'test']], network: true }, 'workspace-write', 'enabled', true],
    [{ stage: 'research', kind: 'research' }, 'workspace-write', 'disabled', true],
    [{ stage: 'research', kind: 'research', researchWeb: false, demoServer: {} }, 'workspace-write', 'enabled', false],
    [{ stage: 'implement', addDirs: ['linked'] }, 'workspace-write', 'disabled', false],
  ]) {
    const profile = permissionProfile(agent, task, 'linux');
    assert.equal(profile.metadata.sandbox.mode, expected);
    assert.equal(profile.metadata.sandbox.network, network);
    assert.deepEqual(profile.webArgs, ['-c', `features.web_search=${web}`]);
    assert.equal(profile.metadata.runtimeObserved, false);
    assert.equal(profile.metadata.enforcement.outsideWorktreeProtectedByPostCheck, false);
    assert.equal(profile.metadata.enforcement.networkProtectedByPostCheck, false);
    assert.equal(profile.metadata.inputs.checks, task.checks?.length || 0);
    assert.equal(profile.metadata.inputs.additionalWriteDirs, task.addDirs?.length || 0);
  }
});

test('permission profile preserves Antigravity explicit false and reports provider settings for other adapters', () => {
  for (const global of [undefined, false, true]) for (const override of [undefined, false, true]) {
    const profile = permissionProfile({ provider: 'antigravity', autoApprove: override }, { agyAutoApprove: global }, 'win32');
    const skip = override ?? global ?? false;
    assert.deepEqual(profile.args, skip ? ['--dangerously-skip-permissions'] : []);
    assert.equal(profile.metadata.approval.mode, skip ? 'skip-permissions' : 'provider-settings');
    assert.equal(profile.metadata.settings.autoApprove.source, override != null ? 'agent' : global != null ? 'task' : 'default');
    assert.equal(profile.metadata.sandbox.filesystem, 'provider-settings');
    assert.equal(profile.metadata.sandbox.network, 'provider-settings');
  }
  for (const stage of ['plan', 'implement', 'review', 'research']) for (const checks of [[], [['node', '--test']]]) {
    const task = { stage, kind: 'research', checks, researchWeb: false };
    const claude = permissionProfile({ provider: 'claude' }, task);
    assert.deepEqual(claude.args, claudeToolArgs(task, checks.map(c => c.join(' ')), false));
    assert.deepEqual(claude.webArgs, ['--disallowedTools', 'WebFetch,WebSearch']);
    const gemini = permissionProfile({ provider: 'gemini' }, task);
    assert.equal(gemini.metadata.approval.mode, stage === 'implement' ? 'auto_edit' : checks.length ? 'default' : 'plan');
    for (const p of [claude, gemini]) {
      assert.equal(p.metadata.sandbox.mode, 'not-specified');
      assert.equal(p.metadata.providerSettingsRequired, true);
      assert.equal(p.metadata.sandbox.network, 'provider-settings');
    }
  }
});
