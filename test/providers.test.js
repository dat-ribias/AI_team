import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxArgs, claudeToolArgs } from '../src/providers.js';
import { capabilitiesFor } from '../src/capabilities.js';

const option = (args, name) => args[args.indexOf(name) + 1];
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
  const edits = option(args, '--allowedTools').split(',').filter(tool => /^(Write|Edit)/.test(tool));
  assert.deepEqual(edits, capabilitiesFor('research', 'builder').write.flatMap(prefix => [`Write(${prefix}**)`, `Edit(${prefix}**)`]));
  assert(!edits.includes('Write')); assert(!edits.includes('Edit'));
  for (const stage of ['plan', 'review', 'verify']) assert(!option(claudeToolArgs({ stage, kind: 'research' }), '--tools').includes('Write'));
  for (const checks of [[], ['node --test test/system.test.js']]) {
    const implement = claudeToolArgs({ stage: 'implement' }, checks);
    assert.equal(option(implement, '--permission-mode'), 'acceptEdits');
    assert(!implement.includes('--tools'));
    const allowed = option(implement, '--allowedTools').split(',');
    for (const tool of ['Bash(node --test)', 'Bash(node --test *)', 'Bash(node --check *)', 'Bash(npm test)', 'Bash(npm test *)', 'Bash(git diff *)', ...checks.flatMap(c => [`Bash(${c})`, `Bash(${c} *)`])]) assert(allowed.includes(tool));
    assert(!allowed.some(tool => tool === 'Bash' || tool === 'Bash(*)' || tool.startsWith('Bash(node -e') || tool.startsWith('Bash(node *')));
  }
  const checking = claudeToolArgs({ stage: 'review' }, ['node --test'], true);
  assert(option(checking, '--allowedTools').includes('Bash(node --test),Bash(node --test *)'));
  assert(option(checking, '--tools').includes('WebSearch,WebFetch'));
});
