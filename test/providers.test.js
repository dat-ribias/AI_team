import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxArgs, claudeToolArgs } from '../src/providers.js';
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
