const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};
const cell = (write = [], options = {}) => ({ write, demoServer: false, network: true, editTests: false, delete: false, runChecks: false, ...options });

// Trần tĩnh; quyền thật còn bị giới hạn bởi caps và quyền project/phiên.
export const CAPABILITIES = freeze({
  code: {
    manager: cell(),
    builder: cell(['*'], { editTests: true, delete: true, runChecks: true }),
    reviewer: cell([], { runChecks: true }),
    verifier: cell(['.ai-team/evidence/'], { runChecks: true }),
  },
  research: {
    manager: cell(),
    builder: cell(['.ai-team/evidence/'], { demoServer: true }),
    reviewer: cell(),
    verifier: cell(),
  },
});
export const TASK_KINDS = freeze({ code: ['implement', 'review'], research: ['research', 'review'] });
export const DEMO = freeze({ maxMinutes: 15, reservedPorts: [3333] });
const denied = freeze(cell([], { network: false }));
const jobKind = kind => kind === 'research' ? 'research' : 'code';

export function capabilitiesFor(kind, role) {
  const roles = CAPABILITIES[jobKind(kind)];
  return Object.hasOwn(roles, role) ? roles[role] : denied;
}

export function canWrite(kind, role, path) {
  if (typeof path !== 'string') return false;
  const file = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
  if (!file || file.startsWith('/') || /^[a-z]:/.test(file) || file.split('/').includes('..')) return false;
  return capabilitiesFor(kind, role).write.some(prefix => prefix === '*' || file.startsWith(prefix.toLowerCase()));
}

const rules = caps => `write: ${caps.write.join(', ') || 'none'}; controller-managed temporary demo server: ${caps.demoServer ? 'allowed' : 'forbidden'}; network: ${caps.network ? 'allowed subject to caps/project access' : 'forbidden'}; edit tests: ${caps.editTests ? 'allowed' : 'forbidden'}; delete: ${caps.delete ? 'allowed' : 'forbidden'}; run checks: ${caps.runChecks ? 'allowed' : 'forbidden'}; writing outside the listed paths and agent-started servers are forbidden`;

export function describeCapabilities() {
  const matrix = Object.entries(CAPABILITIES).flatMap(([kind, roles]) => Object.entries(roles).map(([role, caps]) => `${kind}.${role}: ${rules(caps)}.`));
  const tasks = Object.entries(TASK_KINDS).map(([kind, kinds]) => `${kind} task kinds: ${kinds.join(', ')}`).join('; ');
  const write = CAPABILITIES.research.builder.write.join(', ');
  return [...matrix, `${tasks}.`, `Research builders may write only ${write} (git-ignored, never commit); the controller may grant a temporary demo server using a temporary data directory, excluding ports ${DEMO.reservedPorts.join(', ')}, stopped after at most ${DEMO.maxMinutes} minutes or when the agent call ends; agents must not start servers themselves; editing src/, public/, locales/, test/ and every other file is forbidden.`].join('\n');
}

export function roleRules(kind, role) {
  return `${jobKind(kind)}.${role}: ${rules(capabilitiesFor(kind, role))}.`;
}

// Kiểm tra plan thô, trước khi controller gán kind mặc định cho task.
export function checkPlan(plan) {
  const kind = jobKind(plan.kind), violations = [];
  for (const [i, task] of (plan.tasks || []).entries()) {
    const label = `T${i + 1}`;
    if (task.kind !== undefined && !TASK_KINDS[kind].includes(task.kind)) violations.push(`${label}: task kind '${task.kind}' is not allowed for a ${kind} job (${TASK_KINDS[kind].join(', ')}).`);
    if (task.kind !== 'review') for (const file of task.files || []) {
      if (!canWrite(kind, 'builder', file)) violations.push(`${label}: file '${file}' is outside the ${kind} builder write permissions.`);
    }
  }
  return violations;
}
