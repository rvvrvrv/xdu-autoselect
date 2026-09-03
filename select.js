#!/usr/bin/env node
/**
 * 西电选课系统自动选课脚本（xsxk-autoselect）  v2（已按真实页面校准）
 *
 * 设计分工：
 *   - 登录（含验证码）：由人在弹出的浏览器窗口手动完成。
 *   - 进入选课界面、选课、确认、切换界面（登出→重新登录）、重试与翻车预案：由脚本完成。
 *
 * 已校准的页面结构（2026-09-02 实测）：
 *   登录页:      #loginDiv 登录卡片 / 登出后回到 index.html
 *   选课页:      /elective/grablessons?batchId=...   （需先写 Authorization cookie，否则被重定向回 index）
 *   顶部菜单:    ul.teachingClassTypeMenu > li.el-menu-item（方案内: 推荐班级课程|体育俱乐部|课程查询|已选课程；
 *                通识: 通识教育选修课|课程查询|已选课程）
 *   搜索:        .search-item[data-type=KEY] input + 搜索按钮
 *   课程行:      .el-table__body tr.el-table__row（行内含 .el-table__expand-icon；已选的行代码单元格带 .has-choosed-course）
 *   教学班:      .el-table__expanded-cell > .el-card.jxb-card（卡头 .card-item.head 显示 [序号]教师；含 课容量/已选人数；
 *                按钮: 教学班详情(basic) + 选择(primary)；通识页为 选择志愿）
 *   确认框:      .el-message-box（确认选择课程吗？→ 确定）
 *   成功提示:    .el-message--success「已进入选课队列，请稍后」
 *   通识页内部:  .el-tabs__item（方案课程|校公选课|退课日志）
 *   登出:        选课页 a.logout-btn / 首页右上 退出 / 圆形菜单 .slide-item[title=退出]
 *
 * 用法：
 *   node select.js                 # 按 config.json 顺序跑完整流程
 *   node select.js --reset         # 清除断点状态
 *   node select.js --step plan|general
 *   node select.js --inspect       # 进入界面导出快照并退出（不点选课）
 *   node select.js --dry           # 演练：进入界面并打印将点击的行，不做选课点击
 */
'use strict';

const { normalizeBrowser } = require('./lib/browser');
const { loadPlaywright } = require('./lib/playwright-loader');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');
const BASE_URL = 'https://xk.xidian.edu.cn/xsxk';
const INDEX_URL = BASE_URL + '/profile/index.html';
const GRABLESSONS = BASE_URL + '/elective/grablessons';

/* ---------------- 配置 ---------------- */
function loadConfig() {
  const defaults = {
    username: '',
    interfaceOrder: ['plan', 'general'],
    batches: {},
    timing: { autoStartTime: null, waitForBatchStart: false, startSlippageMs: 0 },
    retry: { maxAttempts: 10, baseDelayMs: 3000, maxDelayMs: 60000 },
    loginWaitMs: 600000,
    busyMarkers: ['系统繁忙', '访问人数过多', '排队中', '请稍后重试', '服务器开小差', '加载失败'],
    successTexts: ['已进入选课队列', '选课成功', '成功'],
    headless: false,
    snapshotDir: 'snapshots',
  };
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) {}
  const cfg = Object.assign(defaults, user);
  cfg.retry = Object.assign(defaults.retry, user.retry || {});
  cfg.timing = Object.assign(defaults.timing, user.timing || {});
  return cfg;
}

/* ---------------- 状态（断点续跑） ---------------- */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) { return { done: [], batchCode: {} }; }
}
function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function markDone(state, id) {
  if (!state.done.includes(id)) { state.done.push(id); saveState(state); }
}
function isDone(state, id) { return state.done.includes(id); }

/* ---------------- 日志/交互 ---------------- */
function ts() { return new Date().toLocaleString('zh-CN', { hour12: false }); }
function log(...a) { console.log(`[${ts()}]`, ...a); }
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
async function pauseForManual(text) {
  log('');
  log('************************************************************');
  log('* ' + text);
  log('* 浏览器保持打开。你可以直接在窗口里手动操作。');
  log('* 完成后回到这里按回车继续（Ctrl+C 中断脚本，状态已保存）。');
  log('************************************************************');
  await ask('》按回车继续...');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- 页面小工具 ---------------- */
async function bodyText(page) {
  try { return await page.locator('body').innerText({ timeout: 3000 }); } catch (_) { return ''; }
}
async function visible(page, selector, timeout = 3000) {
  try { return await page.locator(selector).first().isVisible({ timeout }); } catch (_) { return false; }
}
/* isBusy 已按“只在登录系统场景出现”的观察收敛：选课主路径不做繁忙预判，
 * 系统繁忙由提交反馈+重试轮兜底（服务端会返回“本轮次暂未开始/系统繁忙”类提示）。 */
function snapshot(page, cfg, name) {
  const dir = path.join(ROOT, cfg.snapshotDir || 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const f = path.join(dir, `${name}-${stamp}`);
  page.screenshot({ path: f + '.png' }).catch(() => {});
  log(`📸 快照：${f}`);
  return page.content()
    .then((h) => fs.writeFileSync(f + '.html', h))
    .catch(() => {})
    .then(() => f);
}

/* ---------------- 登录（人工） ---------------- */
async function detectLoggedIn(page) {
  try {
    if (page.url().includes('/elective/')) return true;
    if (!(await visible(page, '#loginDiv', 1500))) return true;
    const txt = await bodyText(page);
    if (txt.includes('开始选课') || txt.includes('退出') || txt.includes('切换轮次')) return true;
  } catch (_) {}
  return false;
}

async function waitForManualLogin(page, cfg, phaseLabel) {
  log('');
  log(`───────────────── 请人工登录 · ${phaseLabel} ─────────────────`);
  log('浏览器窗口已打开：' + INDEX_URL);
  if (cfg.username) log('1) 学号已自动填入' + (cfg.password ? '，密码已自动填入' : '，请输密码'));
  else log('1) 输入学号、密码');
  log('2) 手动完成验证码（点击式/输入式）');
  log('3) 点击“登 录”');
  log('（脚本等待登录成功，最长 ' + Math.round(cfg.loginWaitMs / 60000) + ' 分钟）');
  log('──────────────────────────────────────────────');

  try {
    const u = page.locator('#loginDiv input.el-input__inner').first();
    if (await u.isVisible({ timeout: 3000 })) {
      if (cfg.username) await u.fill(cfg.username);
      if (cfg.password) {
        const p = page.locator('#loginDiv input[type="password"]').first();
        if (await p.isVisible({ timeout: 2000 })) await p.fill(cfg.password);
      }
    }
  } catch (_) {}

  const deadline = Date.now() + cfg.loginWaitMs;
  while (Date.now() < deadline) {
    if (await detectLoggedIn(page)) {
      // 关闭「我已知晓」必修课提示（若出现）
      try {
        const dlg = page.locator('.el-dialog__wrapper').filter({ hasText: '我已知晓' }).first();
        if (await dlg.isVisible({ timeout: 2000 })) {
          const cb = dlg.locator('.el-checkbox__original, .el-checkbox__inner').first();
          if (await cb.isVisible({ timeout: 2000 })) { try { await cb.click({ force: true }); } catch (_) {} }
          const ok = dlg.locator('button').filter({ hasText: /确\s*定/ }).first();
          if (await ok.isVisible({ timeout: 2000 })) { try { await ok.click(); } catch (_) {} }
          await sleep(500);
        }
      } catch (_) {}
      log('✓ 检测到已登录，继续');
      return true;
    }
    await sleep(1000);
  }
  log('✗ 等待人工登录超时');
  return false;
}

/* ---------------- 批次/进入选课页 ---------------- */
async function getBatchCode(page, batchName) {
  // 登录过渡竞态：重试最多 5 次（每次 600ms）
  for (let i = 0; i < 5; i++) {
    try {
      const code = await page.evaluate(async (name) => {
        try {
          const r = await axios.post('/web/studentInfo', {});
          const list = (r.data && r.data.data && r.data.data.student && r.data.data.student.electiveBatchList) || [];
          const hit = list.find((b) => (b.name || '').includes(name));
          return hit ? hit.code : '';
        } catch (e) { return ''; }
      }, batchName);
      if (code) return code;
    } catch (_) {}
    await sleep(600);
  }
  return '';
}

async function enterBatch(page, cfg, batchKey, state, opts = {}) {
  const batch = cfg.batches[batchKey];
  let code = state.batchCode[batchKey];
  if (!code) {
    if (!page.url().includes('/elective/')) {
      await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(2000);
    }
    code = await getBatchCode(page, batch.name);
    if (!code) throw new Error('无法获取批次「' + batch.name + '」code（可能未登录/接口失败）');
    state.batchCode[batchKey] = code;
    saveState(state);
    log('✓ 获取批次 code：' + code + '（' + batch.name + '）');
  }
  log('→ 进入选课界面：' + GRABLESSONS + '?batchId=' + code);
  // 模拟页面 startChoose：先把 token 写入 Authorization cookie
  const token = await page.evaluate(() => sessionStorage.getItem('token') || localStorage.getItem('token') || '');
  if (token) {
    await page.context().addCookies([{ name: 'Authorization', value: token, domain: 'xk.xidian.edu.cn', path: '/' }]);
  }
  await page.goto(GRABLESSONS + '?batchId=' + code, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  // 若被重定向回首页（未真正进入），重试一次
  if (!page.url().includes('/elective/')) {
    if (token) {
      await page.context().addCookies([{ name: 'Authorization', value: token, domain: 'xk.xidian.edu.cn', path: '/' }]);
    }
    await page.goto(GRABLESSONS + '?batchId=' + code, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }
  if (!page.url().includes('/elective/')) throw new Error('无法进入选课页（被重定向）');
  if (!opts.skipReady) {
    // 等行出现（不再固定 sleep 3.5s）：选课页渲染完成即返回，抢课更早进入
    try {
      await page.locator('.el-table__body tr.el-table__row').first().waitFor({ state: 'visible', timeout: 12000 });
    } catch (_) {}
    await waitUntilBatchReady(page, cfg);
  }
}

/** 批次就绪检测：见课程行即就绪；未开始则等待；不依赖易误判的“繁忙”扫描 */
async function waitUntilBatchReady(page, cfg) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await visible(page, '.el-table__body tr.el-table__row', 1200)) return true;
    if (await visible(page, '.jxb-card', 800)) return true;
    const txt = await bodyText(page);
    if (txt.includes('未开始') || txt.includes('未到时间') || txt.includes('即将开始')) {
      await sleep(1500);
      continue;
    }
    await sleep(1000);
  }
  log('⚠ 等待批次就绪超时（继续尝试，选课环节自会兜底）');
}

/** 会话探测：调 /elective/user 验证 token 仍有效（带 3s 硬超时）；页面跳回登录页也视为掉线 */
async function checkSession(page, batchKey, state) {
  try {
    const r = await page.evaluate(async (code) => {
      const doReq = () => axios.post('/elective/user', { batchId: code }).catch(() => null);
      const res = await Promise.race([
        doReq(),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (res && res.data && res.data.code === 200) return 'ok';
      if (res && res.data) return 'bad';
      return 'net';
    }, state.batchCode[batchKey] || '');
    if (r === 'ok') return true;
    if (r === 'bad') {
      // 再核页面形态（避免服务器临时故障误判）
      const url = page.url();
      const loginVisible = await visible(page, '#loginDiv', 1000);
      if (loginVisible || !url.includes('/elective/')) return false;
    }
  } catch (_) {}
  const url = page.url();
  const loginVisible = await visible(page, '#loginDiv', 1000).catch(() => false);
  if (loginVisible || !url.includes('/elective/')) return false;
  return true;
}

/** 等待到设定的开始时间（服务器时钟校准；等待期保活；临界 10s 内零网络，绝不挤占开点瞬间） */
async function waitToStart(cfg, page, batchKey, state) {
  if (!cfg.timing || !cfg.timing.waitForBatchStart || !cfg.timing.autoStartTime) return;
  const start = new Date((cfg.timing.autoStartTime || '').replace(/-/g, '/'));
  if (isNaN(start)) return;
  const target = start.getTime() + (cfg.timing.startSlippageMs || 0);
  const HARD = 10000;    // 硬临界线：剩余少于 10s 时，绝不发起任何网络/DOM 操作
  const serverOffset = async () => {
    try {
      const off = await page.evaluate(async () => {
        const doReq = () => axios.post('/web/now', {}).catch(() => null);
        const r = await Promise.race([
          doReq(),
          new Promise((res) => setTimeout(() => res(null), 3000)),
        ]);
        if (r && r.data && r.data.code === 200 && r.data.data) {
          return Date.parse(String(r.data.data)) - Date.now();
        }
        return null;
      }).catch(() => null);
      return typeof off === 'number' && Math.abs(off) < 600000 ? off : 0;
    } catch (_) { return 0; }
  };
  let offset = await serverOffset();
  log(`⏳ 等待批次开始（服务器时钟偏差 ${offset >= 0 ? '+' : ''}${(offset / 1000).toFixed(1)}s）。页面已预热：每 20s 探测、临近 60s 加密到 5s/次、最后 10s 静默冲刺，开点瞬间不被任何检查挤占。`);

  let lastProbe = 0, lastClick = 0, lastCal = 0;
  // 保活前先做一次完整探测（若此刻已掉线早发现）
  if (await checkSession(page, batchKey, state) === false) {
    log('⚠ 预热后会话即不可用，等待重登逻辑将在首次探测后触发（见下）。');
  }
  while (true) {
    const remain = target + offset - Date.now();
    if (remain <= 0) break;
    if (remain < HARD) {
      // 临界区：纯本地时钟冲刺，零网络、零 DOM 操作 —— 开点绝不延误
      await sleep(40);
      continue;
    }

    // 时钟校准（仅线外，超时保护）
    if (Date.now() - lastCal > 50000) {
      lastCal = Date.now();
      offset = await serverOffset();
    }

    // 会话探测：普通期 20s，临近(60s内)加密到 5s；带 3s 硬超时
    const interval = remain < 60000 ? 5000 : 20000;
    if (Date.now() - lastProbe > interval) {
      lastProbe = Date.now();
      const ok = await checkSession(page, batchKey, state);
      if (!ok) {
        log('⚠ 会话丢失/被踢下线！请重新登录（验证码）...');
        state.done = (state.done || []).filter((id) => id !== batchKey + '/login' && id !== batchKey + '/enter');
        saveState(state);
        await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(1200);
        await waitForManualLogin(page, cfg, (cfg.batches[batchKey] || {}).name + '（掉线重新登录）');
        await enterBatch(page, cfg, batchKey, state, {});
        lastProbe = Date.now();
        continue;
      }
    }
    // UI 点击保活（仅 60s 线外执行，避免临近时页面切换干扰）
    if (remain > 60000 && Date.now() - lastClick > 60000) {
      lastClick = Date.now();
      try {
        await menuTo(page, '推荐班级课程');
      } catch (_) {}
    }

    if (remain < 30000) log(`⏳ 剩余 ${(remain / 1000).toFixed(1)} 秒（${remain < 15000 ? '即将静默冲刺' : '加密探测中'}）`);
    await sleep(Math.min(remain - HARD, interval));
  }
  log('⏰ 到点，开始行动！');
}

/* ---------------- 选课页导航 ---------------- */
async function menuTo(page, label) {
  const items = page.locator('ul.teachingClassTypeMenu li.el-menu-item');
  for (let i = 0; i < await items.count(); i++) {
    const it = items.nth(i);
    const txt = (await it.innerText().catch(() => '')).trim();
    if (!txt.includes(label)) continue;
    const cls = (await it.getAttribute('class').catch(() => '')) || '';
    if (cls.includes('is-active')) return true;   // 已在此 tab，免点击
    await it.click({ timeout: 5000 }).catch(() => {});
    break;
  }
  try {
    await page.locator('.el-table__body tr.el-table__row').first().waitFor({ state: 'visible', timeout: 5000 });
  } catch (_) {}
  await sleep(150);
  return true;
}

async function gotoInternalTab(page, label) {
  const tab = page.locator('.el-tabs__item').filter({ hasText: label }).first();
  if (!(await tab.isVisible({ timeout: 4000 }))) return false;
  await tab.click({ timeout: 4000 }).catch(() => {});
  await sleep(1600);
  return true;
}

/** 关键词搜索（KEY 输入框 + 搜索按钮） */
async function searchByKeyword(page, keyword) {
  const input = page.locator('.search-item[data-type="KEY"] input.el-input__inner').first();
  if (await input.isVisible({ timeout: 4000 })) {
    await input.fill(keyword);
    const btn = page.locator('.search-content button').filter({ hasText: /搜/ }).first();
    if (await btn.isVisible({ timeout: 3000 })) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      await sleep(1800);
      return true;
    }
  }
  return false;
}

async function clearSearch(page) {
  const input = page.locator('.search-item[data-type="KEY"] input.el-input__inner').first();
  if (await input.isVisible({ timeout: 2000 })) {
    await input.fill('');
    const btn = page.locator('.search-content button').filter({ hasText: /搜/ }).first();
    if (await btn.isVisible({ timeout: 3000 })) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      await sleep(1500);
    }
  }
}

/* ---------------- 表格/教学班 ---------------- */
async function courseRows(page) {
  return page.locator('.el-table__body tr.el-table__row');
}

async function findCourseRow(page, name) {
  const rows = await courseRows(page);
  for (let i = 0; i < await rows.count(); i++) {
    const r = rows.nth(i);
    const t = await r.innerText().catch(() => '');
    if (t.includes(name)) return r;
  }
  return null;
}

/** 兜底：跨页查找（课程不在当前页时翻到下一页继续找，最多 maxPages 页）——单次 evaluate 实现 */
async function findRowAcrossPages(page, name, maxPages = 5) {
  const LOC = '.el-table__body tr.el-table__row';
  for (let p = 1; p <= maxPages; p++) {
    const idx = await page.evaluate((arg) => {
      const rows = Array.from(document.querySelectorAll(arg.sel));
      for (let i = 0; i < rows.length; i++) {
        if ((rows[i].innerText || '').includes(arg.nm)) return i;
      }
      return -1;
    }, { nm: name, sel: '.el-table__body tr.el-table__row' });
    if (idx >= 0) return page.locator(LOC).nth(idx);
    const gone = await page.evaluate(() => {
      const next = document.querySelector('.el-pagination .btn-next');
      return !next || next.disabled === true || /disabled/.test(next.className);
    });
    if (gone) return null;
    await page.evaluate(() => {
      const next = document.querySelector('.el-pagination .btn-next');
      if (next) next.click();
    });
    await sleep(500);
  }
  return null;
}

/** 判定某课程行是否已被选（代码单元格带 .has-choosed-course，或行内出现“已选”） */
async function rowIsChosen(row) {
  try { if (await row.locator('.has-choosed-course').count() > 0) return true; } catch (_) {}
  try {
    const t = await row.innerText();
    if (/已选|已加入/.test(t)) return true;
  } catch (_) {}
  return false;
}

/** 展开课程行 → 返回教学班卡片 locator。courseName 用于识别重试残留的展开区，避免重复 toggle。 */
async function expandCourseRow(page, row, courseName) {
  const cards = page.locator('.el-table__expanded-cell .jxb-card');
  if (await cards.count() > 0) {
    const first = (await cards.first().innerText().catch(() => '')).replace(/\s+/g, '');
    if (!courseName || first.includes(courseName)) return cards; // 已展开且是同一课程
  }
  const icon = row.locator('.el-table__expand-icon').first();
  if (await icon.count()) {
    await icon.evaluate((el) => el.click()).catch(() => {});
    try {
      await cards.first().waitFor({ state: 'visible', timeout: 5000 });
    } catch (_) {}
    if (await cards.count() > 0) return cards;
  }
  return null;
}

/** 从卡片里挑一个可选的索引。teacherFilter 支持字符串或数组（按序尝试）；无匹配时回退任意可选。单次 evaluate。 */
async function pickCardIndex(cards, teacherFilter) {
  const teachers = Array.isArray(teacherFilter) ? teacherFilter : (teacherFilter ? [teacherFilter] : []);
  const idx = await cards.evaluateAll((els, ts) => {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const infos = els.map((el) => norm(el.innerText));
    const disabled = els.map((el) => el.querySelectorAll('button.is-disabled, button[disabled]').length > 0);
    const pick = (pred) => {
      let fallback = -1;
      for (let i = 0; i < infos.length; i++) {
        if (pred && !pred(infos[i])) continue;
        if (disabled[i]) continue;
        if (fallback < 0) fallback = i;
        const m = infos[i].match(/课容量[:：]\s*(\d+)\s*人[\s\S]*?已选人数[:：]?\s*(\d+)/);
        if (m && Number(m[2]) < Number(m[1])) return i;
      }
      return fallback;
    };
    for (const t of ts) {
      const i = pick((info) => info.includes(t));
      if (i >= 0) return i;
    }
    return pick(null);
  }, teachers);
  return idx;
}

/** 按优先级（keywords+teacher）挑选教学班卡片索引——单次 evaluate */
async function pickCardByPredicate(cards, priority) {
  const idx = await cards.evaluateAll((els, prio) => {
    const norm = (s) => (s || '').replace(/\s+/g, '');
    const infos = els.map((el) => norm(el.innerText));
    const disabled = els.map((el) => el.querySelectorAll('button.is-disabled, button[disabled]').length > 0);
    const best = (pred) => {
      let fallback = -1;
      for (let i = 0; i < infos.length; i++) {
        if (!pred(infos[i])) continue;
        if (disabled[i]) continue;
        const m = infos[i].match(/课容量[:：]\s*(\d+)\s*人[\s\S]*?已选人数[:：]?\s*(\d+)/);
        if (m && Number(m[2]) < Number(m[1])) return i;
        if (fallback < 0) fallback = i;
      }
      return fallback;
    };
    for (const p of prio) {
      const i = best((info) =>
        (!p.keywords || !p.keywords.length || p.keywords.some((k) => info.includes(k))) &&
        (!p.teacher || info.includes(p.teacher)));
      if (i >= 0) return i;
    }
    return best(() => true);
  }, priority);
  return idx;
}

/** 点教学班卡片的“选择/选择志愿”按钮（evaluate 派发，毫秒级） */
async function clickCardSelect(cards, idx) {
  const ok = await cards.nth(idx).evaluate((card) => {
    const btn = Array.from(card.querySelectorAll('button'))
      .find((b) => /选择|志愿/.test(b.textContent || ''));
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);
  return ok;
}

/** 确认框处理：出现则点“确定”（含志愿单选默认选第一个未选中项）。evaluate 快速版 + 渲染竞态兜底。 */
async function confirmIfAny(page, cfg) {
  for (let i = 0; i < 5; i++) {
    const r = await page.evaluate(() => {
      const wrap = Array.from(document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper'))
        .find((el) => el.style.display !== 'none' && el.getBoundingClientRect().height > 0);
      if (!wrap) return 'none';
      const radio = wrap.querySelector('.el-radio:not(.is-checked) input, .el-radio:not(.is-checked) .el-radio__input');
      if (radio) radio.click();
      const btn = Array.from(wrap.querySelectorAll('button, .el-button'))
        .find((b) => /确\s*定|确\s*认|提\s*交/.test(b.textContent || ''));
      if (btn) { btn.click(); return 'ok'; }
      return 'no-btn';
    });
    if (r === 'none') { await sleep(120); continue; }   // 刚点击确认框可能尚未渲染，补查
    if (r !== 'ok') break;
    await sleep(300);
  }
}

/** 明确失败提示检测：满员/冲突/未开始等。返回失败文案（空=无明确失败） */
async function detectFailure(page, cfg) {
  const bad = ['已满', '满员', '时间冲突', '冲突', '失败', '未开始', '暂未', '请选择', '不能选', '不可选', '人数已满', '容量不足'];
  try {
    const msgs = await page.locator('.el-message, .el-message__content, .el-notification').allInnerTexts().catch(() => []);
    for (const m of msgs) {
      if (bad.some((b) => m.includes(b))) return m.replace(/\s+/g, ' ').slice(0, 50);
    }
  } catch (_) {}
  return '';
}

/** 成功判定：成功 toast / 文本提示 / **本课程行**出现已选标记。kw=课程名关键词（防全局标记误判）。轮询 6×250ms 更快命中。 */
async function detectSuccess(page, cfg, row, kw) {
  for (let i = 0; i < 6; i++) {
    const ok = await page.evaluate((arg) => {
      const t = (document.querySelector('.el-message--success') || {}).innerText || '';
      if (arg.texts.some((s) => t.includes(s))) return true;
      const body = document.body.innerText || '';
      if (arg.texts.some((s) => body.includes(s))) return true;
      // 关键：只认“包含本课程名 且 带已选标记”的行，避免别的已选课程干扰
      if (arg.kw) {
        const rows = Array.from(document.querySelectorAll('.el-table__body tr.el-table__row'));
        const hit = rows.find((r) =>
          (r.innerText || '').includes(arg.kw) && r.querySelector('.has-choosed-course'));
        if (hit) return true;
      }
      return false;
    }, { texts: cfg.successTexts, kw: kw || '' }).catch(() => false);
     if (ok) return true;
    await sleep(250);
  }
  return false;
}

/* ---------------- 登出 ---------------- */
async function logout(page, cfg) {
  try {
    const btn = page.locator('a.logout-btn').first();
    if (!(await btn.isVisible({ timeout: 3000 }))) {
      const slide = page.locator('.slide-item[title="退出"]').first();
      if (await slide.isVisible({ timeout: 3000 })) await slide.click({ timeout: 4000 });
      else {
        const head = page.locator('.cv-pull-right').filter({ hasText: /^退出$/ }).first();
        if (await head.isVisible({ timeout: 3000 })) await head.click({ timeout: 4000 });
        else { await page.evaluate(async () => { try { await axios.post('/auth/logout', {}); } catch (_) {} }); }
      }
    } else {
      await btn.click({ timeout: 5000 });
    }
    await sleep(1500);
    await confirmIfAny(page, cfg);
    await sleep(2000);
  } catch (_) {
    await page.evaluate(async () => { try { await axios.post('/auth/logout', {}); } catch (_) {} }).catch(() => {});
  }
  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(2000);
  log('✓ 已退出登录');
}

/* ---------------- 选课动作 ---------------- */

/**
 * 将一门方案内课程解析成统一的菜单与教学班优先级配置。
 * 新配置使用 menu/priority；section/teacher/clubPriority 为兼容旧配置保留。
 */
function resolvePlanCourse(course = {}) {
  const menuLabel = String(
    course.menu || course.menuLabel ||
    (course.section === 'sportsClub' ? '体育俱乐部' : '推荐班级课程'),
  ).trim();
  const rawPriority = course.priority || course.clubPriority;
  const priority = Array.isArray(rawPriority) && rawPriority.length ? rawPriority : null;
  return { menuLabel, priority, teacher: course.teacher || '' };
}

/**
 * 方案内课程（正选）：菜单 tab → 找行(跨页兜底) → 展开 → 选教学班 → 确认 → 验证
 * - 新配置：menu 指定顶部菜单，priority 按顺序匹配教学班关键词/教师
 * - 旧配置：section/teacher/clubPriority 继续兼容
 */
async function selectPlanCourse(page, cfg, course, label) {
  const strategy = resolvePlanCourse(course);
  for (let a = 1; a <= cfg.retry.maxAttempts; a++) {
    if (!(await menuTo(page, strategy.menuLabel))) {
      log(`  ✗ 找不到顶部菜单（服务异常？）第 ${a} 次`); await sleep(cfg.retry.baseDelayMs); continue;
    }
    // 抢课模式：不搜索——方案内课程列表短，直接找行（含跨页兜底）
    let row = await findRowAcrossPages(page, course.name);
    if (!row) {
      log(`  ✗ 未找到「${course.name}」行（第 ${a}/${cfg.retry.maxAttempts} 轮，稍后重试）`);
      await sleep(cfg.retry.baseDelayMs);
      continue;
    }
    if (await rowIsChosen(row)) {
      log(`⏭ 「${label}」已选（行标记已选），跳过`);
      return 'already';
    }
    const cards = await expandCourseRow(page, row, course.name);
    if (!cards) {
      log(`  ✗ 展开「${course.name}」无教学班卡片（第 ${a} 轮）`);
      await sleep(cfg.retry.baseDelayMs);
      continue;
    }
    let cIdx = -1, pickedWhy = '';
    if (strategy.priority) {
      cIdx = await pickCardByPredicate(cards, strategy.priority);
      if (cIdx >= 0) pickedWhy = JSON.stringify(strategy.priority[0]);
      else pickedWhy = '（优先级项均无可选，退回任意）';
    } else {
      cIdx = await pickCardIndex(cards, strategy.teacher);
    }
    if (cIdx < 0) {
      log(`  ✗ 「${label}」所有教学班不可选/已满（第 ${a} 轮）`);
      await sleep(cfg.retry.baseDelayMs);
      continue;
    }
    const cardInfo = (await cards.nth(cIdx).innerText().catch(() => '')).replace(/\s+/g, ' ');
    log(`  · ${pickedWhy || ''} 尝试教学班：${cardInfo.slice(0, 70)}`);
    await clickCardSelect(cards, cIdx);
    await confirmIfAny(page, cfg);
    await sleep(600);
    // 方案内是“选课排队制”：点了并确认即进入队列、已生效。
    // 判定优先级：明确成功 → 直接成；出现明确失败(满员/冲突/未开始) → 才重试；否则视为已进队列，不再重复点击。
    if (await detectSuccess(page, cfg, row, course.name)) {
      log(`  ✓ 「${label}」选课成功（已进入选课队列，第 ${a} 轮）`);
      return true;
    }
    const failMsg = await detectFailure(page, cfg);
    if (failMsg) {
      log(`  ✗ 明确失败：${failMsg}，第 ${a}/${cfg.retry.maxAttempts} 轮`);
      const delays = [800, 1200, 2000, 4000, 8000, 15000, 30000, 60000];
      const delay = delays[Math.min(a - 1, delays.length - 1)];
      log(`⏳ ${delay}ms 后快重试`);
      await sleep(delay);
      continue;
    }
    log(`  ✓ 「${label}」已提交且无失败提示 → 视为已进入选课队列，不再重复点击`);
    return true;
  }
  return false;
}

/**
 * 通识选修（预选·志愿）：菜单「通识教育选修课」→ 内部 tab「校公选课」
 * 实测结构：每行 = 一个教学班（课程号[班级号] 教学班详情 课程名 教师 时间地点 容量 已选 类别 学分 [选择]按钮）
 * 点「选择」→ 志愿对话框（单选志愿+确定）→ POST /elective/clazz/add
 * 回退：方案课程(FAKCYX) tab 展开行 → 卡片选志愿
 */
async function selectGeneralCourse(page, cfg, candidate, catName, label) {
  const kw = (candidate.keywords || []).join('').trim();
  if (!kw) return null;
  for (let a = 1; a <= cfg.retry.maxAttempts; a++) {
    if (!(await menuTo(page, '通识教育选修课'))) {
      log(`  ✗ 找不到「通识教育选修课」菜单（第 ${a} 轮）`); await sleep(cfg.retry.baseDelayMs); continue;
    }
    await gotoInternalTab(page, '校公选课');
    await searchByKeyword(page, kw);
    // 查找目标行：当前页 → 跨页兜底
    let hit = null;
    const findByPage = async () => {
      const rows = (await courseRows(page));
      let cand = null;
      for (let i = 0; i < await rows.count(); i++) {
        const t = (await rows.nth(i).innerText().catch(() => '')).replace(/\s+/g, '');
        if (!t.includes(kw)) continue;
        if (catName && !t.includes(catName)) continue;
        if (candidate.teacher && !t.includes(candidate.teacher)) continue;
        // 优先无“课程冲突”标记的行
        if (!t.includes('课程冲突')) { return rows.nth(i); }
        if (!cand) cand = rows.nth(i);
      }
      return cand;
    };
    for (let p = 1; p <= 5 && !hit; p++) {
      hit = await findByPage();
      if (!hit) {
        const next = page.locator('.el-pagination .btn-next').first();
        let disabled = true;
        try { disabled = await next.evaluate((el) => el.disabled === true || el.classList.contains('disabled')); } catch (_) {}
        if (!(await next.isVisible({ timeout: 1200 })) || disabled) break;
        await next.click({ timeout: 4000 }).catch(() => {});
        await sleep(600);
      }
    }
    if (!hit) {
      log(`  ✗ 未找到「${label}」行（第 ${a}/${cfg.retry.maxAttempts} 轮）`);
      await sleep(cfg.retry.baseDelayMs);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(2000);
      continue;
    }
    if (await rowIsChosen(hit)) { log(`⏭ 「${label}」已选，跳过`); return 'already'; }
    const hText = (await hit.innerText()).replace(/\s+/g, '');
    const btn = hit.locator('button, a, span').filter({ hasText: /^选择$|选择/ }).first();
    if (await btn.count()) {
      log(`  · 尝试：${hText.slice(0, 90)}`);
      await btn.click({ timeout: 5000 }).catch((e) => { throw new Error('点选失败: ' + e.message); });
      await confirmIfAny(page, cfg);
      await sleep(1500);
      if (await detectSuccess(page, cfg, hit, kw)) {
        log(`  ✓ 「${label}」选课成功（第 ${a} 轮）`);
        return true;
      }
      log(`  ✗ 未检测到成功反馈（可能满员/冲突/系统繁忙），第 ${a}/${cfg.retry.maxAttempts} 轮`);
      await sleep(Math.min(cfg.retry.maxDelayMs, cfg.retry.baseDelayMs * a));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(2000);
      continue;
    }
    // 回退：方案课程 tab 行展开
    log(`  · 「${label}」行内无选择按钮，回退方案课程 tab 展开`);
    await gotoInternalTab(page, '方案课程');
    const row = await findCourseRow(page, kw);
    if (row) {
      const cards = await expandCourseRow(page, row, kw);
      if (cards) {
        const idx = await pickCardIndex(cards, candidate.teacher || '');
        if (idx >= 0) {
          await clickCardSelect(cards, idx);
          await confirmIfAny(page, cfg);
          await sleep(1500);
          if (await detectSuccess(page, cfg, row, kw)) { log(`  ✓ 「${label}」选课成功`); return true; }
        }
      }
    }
    log(`  ✗ 「${label}」第 ${a} 轮未成功`);
    await sleep(cfg.retry.baseDelayMs);
  }
  return false;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const state = loadState();
  const mode = args.includes('--inspect') ? 'inspect' : args.includes('--dry') ? 'dry' : 'run';
  if (args.includes('--reset')) { fs.rmSync(STATE_PATH, { force: true }); log('已清除断点状态'); state.done = []; state.batchCode = {}; }
  if (mode === 'inspect') { state.done = []; state.batchCode = {}; saveState(state); }
  const stepArg = args.indexOf('--step');
  const only = stepArg >= 0 && args[stepArg + 1] ? args[stepArg + 1] : null;
  const steps = only ? [only] : (cfg.interfaceOrder || ['plan', 'general']);
  // 演练/无人值守选项
  const noNow = args.includes('--now');                       // 跳过开始时间等待
  if (args.includes('--tries')) {
    const n = parseInt(args[args.indexOf('--tries') + 1], 10);
    if (n > 0) { cfg.retry.maxAttempts = n; log('重试轮数覆盖为 ' + n); }
  }
  const noPause = args.includes('--nopause');                 // 失败不等待人工
  const P = async (text) => {
    if (noPause) { log('⚠ ' + text + '（--nopause：跳过人工等待）'); return; }
    await pauseForManual(text);
  };

  log('══════════════════════════════════════════');
  log(' 西电选课 自动选课脚本 v2  mode=' + mode + (only ? ' step=' + only : ''));
  log('══════════════════════════════════════════');

  const playwright = loadPlaywright((cfg.browser || {}).playwrightPath);
  const brow = normalizeBrowser(cfg.browser, { channel: 'msedge', headless: cfg.headless, profileDir: '.edge-profile' });
  const { browserCandidates } = require('./lib/browser');
  const profileDir = path.join(ROOT, brow.profileDir);
  let context;
  const lastErr = { message: 'unknown' };
  for (const cand of browserCandidates(brow)) {
    try {
      context = await playwright.chromium.launchPersistentContext(profileDir, {
        ...cand,
        headless: brow.headless,
        args: ['--disable-features=msEdgeFirstRunExperience', '--no-first-run'],
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      log(`✓ 浏览器：${cand.channel || cand.executablePath || 'chromium'}`);
      break;
    } catch (e) { lastErr.message = e && e.message ? e.message : String(e); }
  }
  if (!context) throw new Error('无法启动浏览器：' + lastErr.message);
  const browser = context;
  const page = await browser.newPage(); // launchPersistentContext 返回 context；page 由 context 创建
  page.setDefaultTimeout(15000);
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/elective/clazz/add') || u.includes('/elective/clazz/del') ||
        u.includes('/volunteer/select') || u.includes('/volunteer/xgxk/select')) {
      log(`[net] ${r.request().method()} ${u.replace(BASE_URL, '')} → ${r.status()}`);
    }
  });
  let lastError = null;

  try {
    // 抢课时序：先登录 → 预热进入选课页 → 精确等待开点（服务器时钟）→ 到点立即选课
    // （--now 演练/诊断模式跳过等待）
    for (const batchKey of steps) {
      const batch = cfg.batches[batchKey];
      if (!batch) { log(`✗ 配置中不存在批次：${batchKey}`); continue; }
      log('');
      log(`========== 界面：${batch.name} ==========`);

      if (!isDone(state, batchKey + '/login')) {
        await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(1500);
        const ok = await waitForManualLogin(page, cfg, batch.name);
        if (!ok) { lastError = new Error('登录等待超时'); break; }
        markDone(state, batchKey + '/login');
      }

      if (!isDone(state, batchKey + '/enter')) {
        await enterBatch(page, cfg, batchKey, state, { skipReady: mode === 'inspect' });
        markDone(state, batchKey + '/enter');
      }

      if (!noNow) await waitToStart(cfg, page, batchKey, state);   // 页面已预热，等待到点（服务器时钟校准+保活）

      if (mode === 'inspect') {
        await sleep(4000);
        await snapshot(page, cfg, batchKey + '-inspect');
        log('inspect 完成（快照已保存到 ' + cfg.snapshotDir + '/）');
        break;
      }

      if (mode === 'dry') {
        log(`[dry] 将依次尝试：` + (batch.courses || []).map((c) => c.name || (c.keywords || []).join('/')).join('、'));
        continue;
      }

      if (batchKey === 'plan') {
        for (const course of batch.courses || []) {
          const label = course.name + (course.teacher ? '@' + course.teacher : '');
          const doneId = batchKey + '/选:' + label;
          if (isDone(state, doneId)) { log(`⏭ 已完成：「${label}」`); continue; }
          const ok = await selectPlanCourse(page, cfg, course, label);
          if (ok === true || ok === 'already') markDone(state, doneId);
          else {
            log(`✗ 「${label}」多次尝试未成功 → 人工接管`);
            await P(`「${label}」未成功（可能满员/冲突/系统繁忙）。可手动操作，或按回车再试。`);
          }
        }
      } else if (batchKey === 'general') {
        const plans = batch.plans || [];
        if (!plans.length) {
          log('⚠ config 未配置 general.plans，跳过通识选修');
        } else {
          const gotCat = {};                 // 类别名 -> 已选课程 label
          let gotTotal = 0;
          const want = batch.targetCount || 3;
          for (const plan of plans) {
            if (gotTotal >= want) break;
            const todo = (plan.courses || []).filter((c) => c.category && !gotCat[c.category]);
            if (!todo.length) continue;
            log(`▶ 尝试方案：${(plan.note || '')} → ${todo.map((c) => c.keywords.join('/') + '@' + c.teacher).join(' + ')}`);
            for (const course of todo) {
              if (gotTotal >= want) break;
              if (gotCat[course.category]) continue;
              const label = (course.keywords || []).join('/') + '@' + course.category;
              const doneId = batchKey + '/选:' + label;
              if (isDone(state, doneId)) { gotCat[course.category] = label; gotTotal++; continue; }
              const before = gotTotal;
              const ok = await selectGeneralCourse(page, cfg, course, course.category, label);
              if (ok === true || ok === 'already') {
                markDone(state, doneId);
                if (!gotCat[course.category]) { gotCat[course.category] = label; gotTotal++; }
              } else {
                log(`✗ ${label} 未成功，继续方案内下一个可选项`);
              }
              if (gotTotal === before) await sleep(Math.min(cfg.retry.maxDelayMs, cfg.retry.baseDelayMs * 2));
            }
          }
          if (gotTotal < want) {
            log(`⚠ 本轮共成功 ${gotTotal}/${want} 门通识选修（每类最多 1 门，未齐的课下学期可再选）。`);
          }
          const summary = Object.entries(gotCat).map(([k, v]) => `${k}: ${v.split('@')[0]}`).join(' | ');
          if (summary) log(`✅ 通识选修最终：${summary}`);
        }
      }

      if (mode === 'run') await snapshot(page, cfg, batchKey + '-done');

      const idx = steps.indexOf(batchKey);
      if (idx < steps.length - 1) {
        if (!isDone(state, batchKey + '/logout')) {
          await logout(page, cfg);
          markDone(state, batchKey + '/logout');
        }
      }
    }

    log('');
    log('══════════════════════ 完成 ══════════════════════');
    log('所有步骤执行完毕。建议打开浏览器人工核对已选课程列表。');
  } catch (e) {
    lastError = e;
    log('');
    log('✗ 脚本异常：' + (e && e.message ? e.message : e));
    log('  断点已保存，重新运行 node select.js 会从断点继续。');
    await P('出现异常。请先在浏览器手动处理，或 Ctrl+C 退出后重新运行。').catch(() => {});
  } finally {
    try { await browser.close(); } catch (_) {}
    rl.close();
    if (lastError && mode === 'run') process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
}

module.exports = {
  loadConfig, waitForManualLogin, getBatchCode, enterBatch, snapshot, sleep,
  bodyText, INDEX_URL, GRABLESSONS, BASE_URL, detectLoggedIn, menuTo, courseRows,
  resolvePlanCourse,
};
