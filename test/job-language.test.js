import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Team, detectJobLanguage } from '../src/team.js';
import { run } from '../src/process.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-job-language-'));
  const path = join(root, 'repo');
  let team;
  t.after(async () => {
    if (team) await team.close();
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('ai-team-job-language-'));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path);
  await run(['git'], ['init', '-b', 'main', path]);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n', 'utf8');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false,
    agents: ['lead', 'builder', 'reviewer', 'verifier'].map(id => ({ id, label: id, provider: 'mock' })),
    pipeline: { manager: 'lead', builders: ['builder'], reviewer: 'reviewer', verifier: 'verifier' },
    projects: [{ id: 'test', path, tests: [] }],
  };
  team = new Team(config, join(root, 'data'), {
    runAgent: async () => ({ summary: 'Đã kiểm tra', status: 'completed', findings: [] }),
  });
  team.kick = () => {};
  return team;
}

test('detectJobLanguage recognizes goals and only confident owner steering', () => {
  for (const [text, lang] of [['Sửa lỗi báo cáo', 'vi'], ['日本語の報告を確認する', 'ja'], ['Update the report', 'en'], ['Đã sửa'.normalize('NFD'), 'vi']]) {
    assert.equal(detectJobLanguage(text), lang);
  }
  assert.equal(detectJobLanguage('', 'ja'), 'ja');
  for (const text of ['ok', 'LGTM', '79d7dca', 'src/team.js:1630']) assert.equal(detectJobLanguage(text, 'vi', true), null, text);
  for (const [text, lang] of [['Tiếp tục bằng tiếng Việt', 'vi'], ['日本語で報告してください', 'ja'], ['Please write the remaining reports in English for the project owner.', 'en']]) {
    assert.equal(detectJobLanguage(text, 'vi', true), lang);
  }
});

test('job creation persists detected languages and valid manual overrides, rejecting invalid languages', async t => {
  const team = await fixture(t);
  for (const [goal, expected] of [['Sửa lỗi báo cáo', 'vi'], ['日本語で報告してください', 'ja'], ['Update the report', 'en']]) {
    const job = await team.create({ project: 'test', goal, paused: true });
    assert.equal(job.lang, expected);
    assert.equal(team.get(job.id).lang, expected);
  }
  for (const lang of ['vi', 'ja', 'en']) {
    const job = await team.create({ project: 'test', goal: 'Sửa lỗi báo cáo', lang, paused: true });
    assert.equal(team.get(job.id).lang, lang);
  }
  for (const lang of ['xx', '', 'VI', null]) await assert.rejects(team.create({ project: 'test', goal: 'Update', lang, paused: true }), /vi.*en.*ja/);
});

test('owner messages retain Vietnamese for technical replies and update for clear language changes', async t => {
  const team = await fixture(t);
  const job = await team.create({ project: 'test', goal: 'Sửa lỗi báo cáo', paused: true });
  for (const message of ['ok', 'LGTM', '79d7dca', 'src/team.js:1630']) {
    await team.control(job.id, 'message', { message });
    assert.equal(team.get(job.id).lang, 'vi', message);
  }
  for (const [message, lang] of [['Please write the remaining reports in English for the project owner.', 'en'], ['日本語で報告してください', 'ja'], ['Tiếp tục bằng tiếng Việt', 'vi']]) {
    const stale = team.get(job.id);
    await team.control(job.id, 'message', { message });
    assert.equal(team.get(job.id).lang, lang);
    assert.equal(team.get(job.id).messages.at(-1).text, message);
    team.save(stale);
    assert.equal(team.get(job.id).lang, lang, 'stale worker must preserve the newest language');
  }
});

test('language control overrides and persists the language without accepting invalid values', async t => {
  const team = await fixture(t);
  const job = await team.create({ project: 'test', goal: 'Sửa lỗi báo cáo', paused: true });
  for (const lang of ['ja', 'en', 'vi']) {
    const stale = team.get(job.id);
    await team.control(job.id, 'language', { lang });
    assert.equal(team.get(job.id).lang, lang);
    team.save(stale);
    assert.equal(team.get(job.id).lang, lang);
  }
  for (const lang of ['xx', '', null, undefined]) {
    await assert.rejects(team.control(job.id, 'language', { lang }), /vi.*en.*ja/);
    assert.equal(team.get(job.id).lang, 'vi');
  }
});

test('language locale additions parse in all three dictionaries without mojibake', () => {
  for (const lang of ['vi', 'ja', 'en']) {
    const dictionary = JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of ['srv.team.language_invalid', 'srv.team.language_changed', 'srv.team.language_warning']) {
      assert.equal(typeof dictionary[key], 'string', `${lang}: ${key}`);
      assert(dictionary[key].length > 0, `${lang}: ${key}`);
      assert.doesNotMatch(dictionary[key], /Ã|á»|\uFFFD/, `${lang}: ${key}`);
    }
  }
});
