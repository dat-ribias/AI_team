import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, TASK_KINDS, DEMO, capabilitiesFor, canWrite, describeCapabilities, roleRules, checkPlan } from '../src/capabilities.js';

test('capability matrix preserves the static ceilings and is deeply frozen', () => {
  const base = { write: [], demoServer: false, network: true, editTests: false, delete: false, runChecks: false };
  assert.deepEqual(CAPABILITIES, {
    code: {
      manager: base,
      builder: { ...base, write: ['*'], editTests: true, delete: true, runChecks: true },
      reviewer: { ...base, runChecks: true },
      verifier: { ...base, write: ['.ai-team/evidence/'], runChecks: true },
    },
    research: {
      manager: base,
      builder: { ...base, write: ['.ai-team/evidence/'], demoServer: true },
      reviewer: base,
      verifier: base,
    },
  });
  const frozen = value => {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) if (child && typeof child === 'object') frozen(child);
  };
  for (const value of [CAPABILITIES, TASK_KINDS, DEMO]) frozen(value);
  assert.throws(() => CAPABILITIES.research.builder.write.push('src/'), TypeError);
  assert.deepEqual(TASK_KINDS, { code: ['implement', 'review'], research: ['research', 'review'] });
  assert.deepEqual(DEMO, { maxMinutes: 15, reservedPorts: [3333] });
});

test('unknown kinds default to code and unknown roles deny all permissions', () => {
  assert.equal(capabilitiesFor('unknown', 'builder'), CAPABILITIES.code.builder);
  for (const role of ['unknown', 'constructor', '__proto__', undefined]) {
    const caps = capabilitiesFor('research', role);
    assert.deepEqual(caps, { write: [], demoServer: false, network: false, editTests: false, delete: false, runChecks: false });
    assert.equal(Object.isFrozen(caps), true);
    assert.equal(Object.isFrozen(caps.write), true);
  }
});

test('write permissions normalize paths and reject absolute paths and traversal', () => {
  for (const file of ['.ai-team/evidence/a.png', './.ai-team/evidence/a.png', '.\\.AI-TEAM\\Evidence\\a.png']) {
    assert.equal(canWrite('research', 'builder', file), true, file);
    assert.equal(canWrite('code', 'verifier', file), true, file);
  }
  for (const file of ['src/x.js', 'public/x', 'locales/x', 'test/x', '../x', '.ai-team/evidence/../x', '.ai-team/evidence2/a.png', 'C:/x', 'C:\\x', '/x', '\\\\server\\x', '', null]) {
    assert.equal(canWrite('research', 'builder', file), false, String(file));
  }
  for (const file of ['../x', 'src/../x', 'C:/x', '/x', './C:/x']) assert.equal(canWrite('code', 'builder', file), false, file);
  assert.equal(canWrite('code', 'builder', 'src/x.js'), true);
  assert.equal(canWrite('code', 'manager', 'src/x.js'), false);
  assert.equal(canWrite('research', 'verifier', '.ai-team/evidence/a.png'), false);
});

test('plan checks reject incompatible task kinds and files without changing the plan', () => {
  const plan = { kind: 'research', tasks: [{ kind: 'implement', files: ['src/x.js'] }, { kind: 'research', files: ['test/x.js'] }] };
  const before = structuredClone(plan);
  const violations = checkPlan(plan);
  assert.equal(violations.length, 3);
  assert.match(violations[0], /T1.*implement/);
  assert.match(violations[1], /T1.*src\/x\.js/);
  assert.match(violations[2], /T2.*test\/x\.js/);
  assert.deepEqual(plan, before);
  for (const valid of [
    { kind: 'research', tasks: [{ kind: 'research', files: ['.ai-team/evidence/a.png'] }] },
    { kind: 'research', tasks: [{ files: ['.ai-team/evidence/a.png'] }] },
    { kind: 'research', tasks: [{ kind: 'review', files: ['src/x.js'] }] },
    { kind: 'code', tasks: [{ kind: 'implement', files: ['src/x.js'] }] },
    { kind: 'unknown', tasks: [{ kind: 'implement', files: ['src/x.js'] }] },
    {},
  ]) assert.deepEqual(checkPlan(valid), []);
  assert.match(checkPlan({ kind: 'code', tasks: [{ kind: 'research' }] })[0], /T1.*research/);
});

test('prompt descriptions derive the matrix, task kinds and demo limits', () => {
  const description = describeCapabilities();
  for (const [kind, roles] of Object.entries(CAPABILITIES)) for (const [role, caps] of Object.entries(roles)) {
    const line = roleRules(kind, role);
    assert.equal(description.split('\n').includes(line), true);
    assert.ok(line.includes(`write: ${caps.write.join(', ') || 'none'}`));
    assert.ok(line.includes(`run checks: ${caps.runChecks ? 'allowed' : 'forbidden'}`));
    assert.ok(line.includes(`temporary demo server: ${caps.demoServer ? 'allowed' : 'forbidden'}`));
  }
  assert.match(description, /3333/);
  assert.match(description, /\.ai-team\/evidence\//);
  assert.match(description, /research task kinds: research, review/);
  assert.match(description, /15 minutes or when the agent call ends/);
  assert.match(description, /temporary data directory/);
  assert.match(description, /agents must not start servers themselves/);
  assert.match(description, /git-ignored, never commit/);
  assert.match(description, /src\/, public\/, locales\/, test\//);
});
