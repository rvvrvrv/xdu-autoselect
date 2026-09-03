#!/usr/bin/env node
/**
 * configure.js —— 交互式配置向导
 *
 * 问答式生成/更新 config.json，便于下一学期或分享给朋友时快速配置方案内课程。
 * 只把你输入的选项写进本机 config.json；不收集、不入库、不打包任何账号凭证。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normalizeBrowser } = require('./lib/browser');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT_MENU = '推荐班级课程';
const SPORTS_MENU = '体育俱乐部';

/** 把一门课程的输入规整成 select.js 认识的课程对象（纯函数，便于测试）。 */
function buildCourse(input = {}) {
  const name = String(input.name || '').trim();
  const menu = String(input.menu || DEFAULT_MENU).trim();
  const course = { name, menu };
  const priorities = Array.isArray(input.priorities) ? input.priorities : [];
  if (priorities.length) {
    course.priority = priorities;
  } else {
    const teachers = (input.teachers || []).filter(Boolean);
    if (teachers.length) course.teacher = teachers;
  }
  return course;
}

/** 根据向导答案合并出完整配置（纯函数，便于测试）。 */
function buildConfigFromAnswers(base = {}, answers = {}) {
  const config = Object.assign({}, base);
  config.username = answers.username != null ? answers.username : (base.username || '');
  config.interfaceOrder = ['plan'];
  config.batches = Object.assign({}, base.batches || {});
  config.batches.plan = {
    name: answers.batchName || (base.batches && config.batches.plan && config.batches.plan.name) || '第一轮方案内课程',
    courses: (answers.courses || []).map(buildCourse),
  };
  config.timing = Object.assign({}, base.timing || {});
  if (answers.waitForBatchStart != null) config.timing.waitForBatchStart = !!answers.waitForBatchStart;
  if (answers.autoStartTime) config.timing.autoStartTime = answers.autoStartTime;
  config.browser = Object.assign(
    normalizeBrowser(),
    { profileDir: '.browser-profile' },
    { channel: answers.browserChannel || '' },
  );
  return config;
}

/* ---------------- 交互部分 ---------------- */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise((r) => rl.question(`${q}${def ? `（默认 ${def}）` : ''}：`, (a) => r((a || '').trim() || def)));
async function askYes(q, def) {
  const a = (await ask(`${q}（${def ? 'y' : 'n'}）[y/n]`, '')).toLowerCase();
  return a === 'y' || (a === '' && def);
}
async function askList(q) {
  const a = (await ask(q, '')).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  return a;
}
async function askPriorities() {
  const priorities = [];
  while (true) {
    const teacher = await ask('  该教学班教师（留空结束输入）', '');
    if (!teacher) break;
    const keywords = await askList('  该教学班时间/课程关键字，逗号分隔（可空）');
    priorities.push(keywords.length ? { keywords, teacher } : { teacher });
  }
  return priorities;
}

async function main() {
  console.log('==========================================================');
  console.log('  西电选课 · 方案内课程配置向导');
  console.log('  会把你的选择写入 config.json；登录/验证码仍由你人工完成。');
  console.log('==========================================================');

  let base = {};
  try { base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}

  const username = await ask('学号（留空则登录框全手输）', '');
  const batchName = await ask('批次名称', (base.batches && base.batches.plan && base.batches.plan.name) || '第一轮方案内课程');

  const courses = [];
  let more = true;
  while (more) {
    const name = await ask('课程名称关键字（必填，如“大学英语中级”/“高等数学”/“大学体育”）', '');
    if (!name) { console.log('（课程名不能为空，跳过）'); break; }
    const menu = await ask('顶部菜单', DEFAULT_MENU);
    const kind = await askYes('这是体育类（俱乐部）吗？', menu === SPORTS_MENU);
    const finalMenu = kind ? SPORTS_MENU : menu;
    if (kind) {
      const priorities = await askPriorities();
      courses.push({ name, menu: finalMenu, priorities });
    } else {
      const teachers = await askList(`教师优先级，逗号分隔（如 王老师,李老师；可空）`);
      courses.push({ name, menu: finalMenu, teachers });
    }
    more = await askYes('再添加一门课程？', false);
  }

  const wait = await askYes('等待到指定开点时间再抢课？', true);
  let autoStartTime = '';
  if (wait) autoStartTime = await ask('开点时间（如 2026-09-04 09:00:00），留空用默认', (base.timing && base.timing.autoStartTime) || '');

  const q = await ask('浏览器（回车=自动检测，m = Edge，c = Chrome）', '');
  const browserChannel = q === 'm' ? 'msedge' : q === 'c' ? 'chrome' : '';

  const config = buildConfigFromAnswers(base, {
    username, batchName, courses, waitForBatchStart: wait, autoStartTime, browserChannel,
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\n✓ 已写入 ${CONFIG_PATH}`);
  console.log('  下一步：node select.js --dry --now  演练；确认无误后运行 node select.js');
  process.exit(0);
}

if (require.main === module) {
  // --check：已配置过（plan.courses 非空）则退出码 0，否则 1。供一键启动判断是否需弹向导。
  if (process.argv.includes('--check')) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
    const courses = (((cfg.batches || {}).plan || {}).courses) || [];
    process.exit(courses.length ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildConfigFromAnswers, buildCourse };
