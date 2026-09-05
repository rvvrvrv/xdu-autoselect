#!/usr/bin/env node
/**
 * configure.js —— 交互式配置向导
 *
 * 模式一（推荐）自动抓取：先在弹出的浏览器里人工登录（验证码），脚本自动爬取
 *   当前批次的课程与教学班数据，然后在终端列出列表，按编号快捷勾选课程与教师优先级。
 * 模式二手动填写：问答式输入课程名/教师（旧向导，离线兜底）。
 *
 * 只把你的选择写进本机 config.json；不收集、不入库、不打包任何账号凭证。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normalizeBrowser } = require('./lib/browser');
const catalog = require('./lib/course-catalog');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const COURSES_PATH = path.join(ROOT, 'courses.json');

const DEFAULT_MENU = '推荐班级课程';
const SPORTS_MENU = '体育俱乐部';

/* ---------------- 通用纯函数（供测试） ---------------- */

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

/* ---------------- 交互小工具 ---------------- */
/* readline 懒创建：首次提问时才占用 stdin（避免被 require 时抢键盘） */
let _rl = null;
function getRl() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
const ask = (q, def) => new Promise((r) => getRl().question(`${q}${def !== undefined && def !== '' ? `（默认 ${def}）` : ''}：`, (a) => r(String(a || '').trim() || def)));
async function askYes(q, def) {
  const a = (await ask(`${q}（${def ? 'y' : 'n'}）[y/n]`, '')).toLowerCase();
  return a === 'y' || (a === '' && def);
}
async function askList(q) {
  const a = (await ask(q, '')).split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean);
  return a;
}
async function askIdxList(q, max) {
  for (;;) {
    const parts = await askList(q);
    if (!parts.length) return [];
    const idxs = [];
    let ok = true;
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (!(n >= 1 && n <= max)) { console.log(`  ✗ 编号「${p}」无效（1-${max}）`); ok = false; break; }
      idxs.push(n);
    }
    if (ok) return idxs;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 浏览器端抓取（读页面 DOM，只读，不点任何选择按钮） ---------------- */

/** 在当前菜单页抓取全部课程行 + 每行的教学班卡片（含翻页）。 */
async function crawlMenu(page, label, menuLabel) {
  const select = require('./select'); // 复用已校准的导航函数
  if (!(await select.menuTo(page, label))) {
    console.log(`  ✗ 找不到菜单「${label}」，跳过`);
    return [];
  }
  const courses = [];
  for (let pageNo = 1; pageNo <= 30; pageNo++) {
    const rows = page.locator('tr.el-table__row');
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      // 展开行（上一次展开残留）不是课程行，跳过
      if (await row.locator('.el-table__expanded-cell').count()) continue;
      const cells = await row.locator('td .cell').allInnerTexts().catch(() => []);
      if (!cells.length) continue;
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const course = {
        menu: menuLabel,
        name: norm(cells[1]) || norm(cells[0]),
        code: norm(cells[0]),
        meta: cells.slice(2, -1).map(norm).filter(Boolean).join(' / '),
        chosen: !!(await row.locator('.has-choosed-course').count()),
        classes: [],
      };
      // 展开读教学班卡片，读完收起（保持行号稳定）
      const icon = row.locator('.el-table__expand-icon').first();
      if (await icon.count()) {
        // 先收起残留的展开行，避免卡片读取串行
        const open = page.locator('.el-table__expand-icon--expanded');
        while (await open.count()) {
          await open.first().evaluate((el) => el.click()).catch(() => {});
          await sleep(150);
        }
        await icon.evaluate((el) => el.click()).catch(() => {});
        await page.locator('.el-table__expanded-cell .jxb-card').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const cards = await page.locator('.el-table__expanded-cell .jxb-card').evaluateAll((els) => els.map((el) => {
          const head = el.querySelector('.card-item.head .one-row');
          const placeEl = el.querySelector('.card-item.pc-card-ypsjdd');
          const btns = Array.from(el.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
          return {
            title: (head && head.getAttribute('title')) || (head && head.textContent) || '',
            place: placeEl ? placeEl.textContent : '',
            text: el.innerText || '',
            conflict: /课程冲突/.test(el.innerText || ''),
            chosen: btns.some((t) => /退选/.test(t)),
            disabled: !!el.querySelector('button.is-disabled, button[disabled]'),
          };
        })).catch(() => []);
        course.classes = cards.map(catalog.normalizeClass);
        await icon.evaluate((el) => el.click()).catch(() => {});
        await sleep(400);
      }
      courses.push(course);
    }
    // 翻页
    const next = page.locator('.el-pagination .btn-next').first();
    let disabled = true;
    try { disabled = await next.evaluate((el) => el.disabled === true || /disabled/.test(el.className)); } catch (_) {}
    if (!(await next.isVisible({ timeout: 800 }).catch(() => false)) || disabled) break;
    await next.click({ timeout: 4000 }).catch(() => {});
    await sleep(1200);
  }
  return courses;
}

/* ---------------- 模式一：登录 → 爬取 → 列表快捷选择 ---------------- */
async function crawlWizard() {
  console.log('==========================================================');
  console.log('  西电选课 · 自动抓取配置向导');
  console.log('  ① 浏览器弹出后人工登录（含验证码）');
  console.log('  ② 你自己点击进入要配置的选课轮次（脚本只监测，不代点）');
  console.log('  ③ 脚本就地只读爬取课程/教师数据（不点任何选择按钮）');
  console.log('  ④ 终端列表里按编号勾选，自动生成 config.json');
  console.log('==========================================================');

  let base = {};
  try { base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
  const brow = normalizeBrowser(base.browser || {}, { profileDir: '.browser-profile' });

  const { loadPlaywright } = require('./lib/playwright-loader');
  const { browserCandidates } = require('./lib/browser');
  const select = require('./select');
  const playwright = loadPlaywright((base.browser || {}).playwrightPath);

  let context;
  const errs = [];
  for (const cand of browserCandidates(brow)) {
    try {
      context = await playwright.chromium.launchPersistentContext(path.join(ROOT, brow.profileDir), {
        ...cand, headless: false, viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
        args: ['--window-position=-2500,20', '--window-size=1440,940', '--no-first-run',
               '--disable-features=msEdgeFirstRunExperience'],
      });
      break;
    } catch (e) { errs.push(e.message); }
  }
  if (!context) throw new Error('无法启动浏览器：' + errs.join(' | '));
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    await page.goto(select.INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(1500);
    const loginCfg = { username: base.username || '', password: base.password || '', loginWaitMs: 10 * 60 * 1000 };
    const ok = await select.waitForManualLogin(page, loginCfg, '课程抓取（浏览器在副屏，请登录）');
    if (!ok) throw new Error('登录等待超时');

    /* 等待用户自己点进要配置的选课轮次 —— 脚本只监测 URL，不查接口、不代替点击 */
    console.log('\n请在浏览器里点击进入你要配置的选课轮次（点「开始选课」）。');
    console.log('脚本检测到你进入选课界面后自动开始爬取（全程只读，不查任何接口）。');
    const deadline = Date.now() + 30 * 60 * 1000;
    let batchCode = '';
    while (Date.now() < deadline) {
      const m = page.url().match(/grablessons\?batchId=([A-Za-z0-9]+)/);
      if (m && page.url().includes('/elective/')) { batchCode = m[1]; break; }
      await sleep(1000);
    }
    if (!batchCode) throw new Error('等待进入选课界面超时');
    let batchName = '', beginTime = '', endTime = '', batchState = '';
    try {
      const cb = await page.evaluate(() => sessionStorage.getItem('currentBatch') || '');
      if (cb) {
        const j = JSON.parse(cb);
        batchName = j.name || j.batchName || '';
        beginTime = j.beginTime || '';
        endTime = j.endTime || '';
        batchState = j.state || '';
      }
    } catch (_) {}
    if (!batchName) batchName = '选课轮次 ' + batchCode;
    console.log(`✓ 已进入：${batchName}（${batchCode}）`);
    if (beginTime) console.log(`  ℹ 本轮时间：${beginTime} ~ ${endTime || '?'}${batchState ? '（' + batchState + '）' : ''}`);
    console.log('  开始爬取…');
    try { await page.locator('.el-table__body tr.el-table__row').first().waitFor({ state: 'visible', timeout: 12000 }); } catch (_) {}
    await sleep(1500);

    const menuLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('ul.teachingClassTypeMenu li.el-menu-item'))
        .map((el) => (el.innerText || '').trim()).filter((t) => t && !/已选课程|课程查询/.test(t)),
    ).catch(() => []);
    console.log(`\n开始爬取「${batchName}」的菜单：${menuLabels.join('、')}`);
    const courses = [];
    for (const label of menuLabels) {
      console.log(`  ⏳ 正在爬取「${label}」…`);
      const got = await crawlMenu(page, label, label);
      console.log(`     ✓ ${got.length} 门课程`);
      courses.push(...got);
    }
    const catalogData = { batchName, batchCode, capturedAt: new Date().toISOString(), courses };
    fs.writeFileSync(COURSES_PATH, JSON.stringify(catalogData, null, 2));
    console.log(`\n✓ 课程数据已存 ${COURSES_PATH}（共 ${courses.length} 门，可重复运行本向导刷新）`);

    /* 终端快捷选择 */
    const { text, index } = catalog.formatCatalog(catalogData);
    console.log('\n──────────── 课程列表 ────────────');
    console.log(text);
    console.log('──────────────────────────────────');
    const chosen = await askIdxList('勾选要抢的课程编号（空格分隔，如: 1 3 5；直接回车=不选）', index.length);
    if (!chosen.length) { console.log('（未勾选课程，config.json 保持不变）'); return; }

    const picks = [];
    for (const ci of chosen) {
      const entry = index.find((x) => x.idx === ci);
      if (!entry) continue;
      const course = entry.course;
      if (!course.classes.length) { console.log(`「${course.name}」没有可展开的教学班，跳过`); continue; }
      console.log(`\n「${course.name}」的教学班：`);
      course.classes.forEach((c, i) => console.log('  ' + catalog.formatClass(c, i + 1)));
      const classIdx = await askIdxList(`  依优先顺序选教学班（如: 2 1；回车=不抢这门）`, course.classes.length);
      if (classIdx.length) picks.push({ course, classIdx });
    }

    const courseConfigs = catalog.buildCourseConfig(picks);
    if (!courseConfigs.length) { console.log('（没有生成任何课程配置）'); return; }

    console.log('\n──────────── 配置预览 ────────────');
    console.log(JSON.stringify(courseConfigs, null, 2));
    if (!(await askYes('写入 config.json？', true))) { console.log('（已取消，未写入）'); return; }

    const config = buildConfigFromAnswers(base, {
      batchName,
      courses: courseConfigs.map((c) => ({ name: c.name, menu: c.menu, priorities: c.priority || [] })),
    });
    // 开点时间自动检测：采用所选轮次的官方 beginTime（数据来自页面 sessionStorage，不调接口）
    if (beginTime && (await askYes(`开点时间自动设为本轮官方开始时间 ${beginTime}？`, true))) {
      config.timing = Object.assign({}, base.timing || {}, { waitForBatchStart: true, autoStartTime: beginTime });
    }
    config.browser = Object.assign({}, base.browser || {}, { profileDir: brow.profileDir });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`\n✓ 已写入 ${CONFIG_PATH}`);
    console.log('  下一步：node select.js --dry --now  演练；确认无误后运行 node select.js');
    console.log('  （登录态已保留在 ' + brow.profileDir + '/，select.js 会直接复用，无需再登录）');
  } finally {
    try { await context.close(); } catch (_) {}
  }
}

/* ---------------- 主入口 ---------------- */
async function main() {
  console.log('==========================================================');
  console.log('  西电选课 · 配置向导');
  console.log('  会把你的选择写入 config.json；登录/验证码仍由你人工完成。');
  console.log('==========================================================');
  const flag = process.argv.includes('--crawl') ? '1' : process.argv.includes('--manual') ? '2' : '';
  const mode = flag || (await ask('模式：[1] 自动抓取课程列表（推荐，需登录） [2] 手动填写', '1'));
  if (String(mode).trim() === '1') {
    await crawlWizard();
    process.exit(0);
  }
  await manualWizard();
  process.exit(0);
}

async function manualWizard() {
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
      const priorities = [];
      for (;;) {
        const teacher = await ask('  该教学班教师（留空结束输入）', '');
        if (!teacher) break;
        const keywords = await askList('  该教学班时间/课程关键字，逗号分隔（可空）');
        priorities.push(keywords.length ? { keywords, teacher } : { teacher });
      }
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
}

if (require.main === module) {
  // --banner：一键启动.bat 的开屏横幅。bat 自身保持纯 ASCII（cmd 解析 UTF-8 bat 会乱码），
  // 中文统一由 node 打印（走控制台 API，任何代码页下都不乱码）。
  if (process.argv.includes('--banner')) {
    console.log('============================================');
    console.log('  西电选课助手');
    console.log('  - 首次运行会弹出问答，按提示填你的课程');
    console.log('  - 到点后浏览器弹出，人工输验证码即可');
    console.log('  - 其余自动完成');
    console.log('  --------------------------------------------');
    console.log('  - 脚本已尽力应对网络波动与掉线（自动提示重登、断点续跑），');
    console.log('    但它只负责“点选抢课”这一步，意义在于比手速快得多；');
    console.log('  - 因网络或其他原因导致未能按预期抢到课程的，不在本脚本能力范围内，请知悉');
    console.log('============================================');
    process.exit(0);
  }
  // --check：已配置过（plan.courses 非空）则退出码 0，否则 1。供一键启动判断是否需弹向导。
  if (process.argv.includes('--check')) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
    const courses = (((cfg.batches || {}).plan || {}).courses) || [];
    process.exit(courses.length ? 0 : 1);
  }
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildConfigFromAnswers, buildCourse, crawlMenu };
