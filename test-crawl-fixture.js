/* test-crawl-fixture.js —— 用本地夹具（真实快照片段）离线回归 configure.crawlMenu()。
   需要 Edge/Chrome 任一浏览器；不可用时跳过（不阻塞 npm test）。 */
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const { loadPlaywright } = require('./lib/playwright-loader');
  const configure = require('./configure');
  const playwright = loadPlaywright();

  let browser;
  const errs = [];
  for (const launch of [
    () => playwright.chromium.launch({ channel: 'msedge', headless: true }),
    () => playwright.chromium.launch({ channel: 'chrome', headless: true }),
    () => playwright.chromium.launch({ headless: true }),
  ]) {
    try { browser = await launch(); break; } catch (e) { errs.push(e.message.split('\n')[0]); }
  }
  if (!browser) {
    console.log('skip: 无可用浏览器（' + errs.join(' | ') + '）');
    return;
  }
  try {
    const page = await browser.newPage();
    const url = pathToFileURL(path.join(__dirname, 'test-fixture-grablessons.html')).href;
    await page.goto(url, { waitUntil: 'load' });

    const courses = await configure.crawlMenu(page, '推荐班级课程', '推荐班级课程');
    assert.strictEqual(courses.length, 2, '应爬到 2 门课程');

    const [a, b] = courses;
    assert.strictEqual(a.menu, '推荐班级课程');
    assert.ok(a.name.length > 1, '课程名应非空');
    assert.strictEqual(a.chosen, true, '课程A应带已选标记');
    assert.ok(a.classes.length >= 1, '课程A应展开出教学班卡片');
    const ca = a.classes[0];
    assert.strictEqual(ca.teacher, '甲老师');
    assert.strictEqual(ca.chosen, true, '课程A的卡片应为已选（有退选按钮）');

    assert.strictEqual(b.chosen, false, '课程B无已选标记');
    assert.strictEqual(b.classes.length, 15, '课程B应爬到 15 张体育卡片');
    const conflict = b.classes.find((c) => c.conflict);
    assert.ok(conflict, '应识别课程冲突卡片');
    assert.strictEqual(conflict.teacher, '王老师');
    assert.ok(conflict.capacity > 0 && conflict.selected > 0, '容量/已选应解析为数字');
    const chosen = b.classes.find((c) => c.chosen);
    assert.ok(chosen, '应识别已选卡片（退选按钮）');
    const withPlace = b.classes.find((c) => /星期/.test(c.place));
    assert.ok(withPlace, '应解析出上课时间（pc-card-ypsjdd）');

    /* 预定位：已选课程返回 already；未选课程按优先级定位到卡片（不点击） */
    const cfg = { retry: { maxAttempts: 1 } };
    const sel = require('./select');
    const rA = await sel.prePositionCourse(page, cfg, { name: a.name, menu: '推荐班级课程', priority: [{ teacher: '张老师' }] });
    assert.deepStrictEqual(rA, { already: true }, '课程A已选，预定位应返回 already');
    const rB = await sel.prePositionCourse(page, cfg, { name: b.name, menu: '推荐班级课程', priority: [{ teacher: '王老师' }] });
    assert.ok(rB && rB.cardIdx >= 0 && rB.rowIdx >= 0, '课程B应预定位成功');
    assert.ok(rB.cardInfo.includes('王老师'), '预定位应命中王老师的教学班');
    assert.strictEqual(rB.rowIdx, 1, '课程B是第二行');
    console.log('crawl fixture checks passed');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
