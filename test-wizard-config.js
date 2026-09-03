const assert = require('assert');
const { normalizeBrowser, browserCandidates } = require('./lib/browser');
const { buildConfigFromAnswers } = require('./configure');
assert.deepStrictEqual(normalizeBrowser({}), {
  channel: '', executablePath: '', headless: false, profileDir: '.edge-profile',
});
assert.deepStrictEqual(
  normalizeBrowser({ channel: 'chrome', headless: true, profileDir: 'p' }),
  { channel: 'chrome', executablePath: '', headless: true, profileDir: 'p' },
);
assert.deepStrictEqual(browserCandidates({ channel: '', executablePath: '', headless: false, profileDir: '.edge-profile' }), [
  { channel: 'msedge' }, { channel: 'chrome' }, { channel: 'chromium' },
]);
assert.deepStrictEqual(browserCandidates({ channel: 'chrome', executablePath: '', headless: false, profileDir: '.edge-profile' }), [
  { channel: 'chrome' },
]);
assert.deepStrictEqual(browserCandidates({ channel: '', executablePath: 'C:/x/msedge.exe', headless: false, profileDir: '.edge-profile' }), [
  { executablePath: 'C:/x/msedge.exe' },
]);
const base = {
  username: '', interfaceOrder: ['plan', 'general'],
  batches: { plan: { name: 'old', courses: [] }, general: { name: 'g' } },
  timing: { autoStartTime: 'old', waitForBatchStart: true },
};
const ans = {
  username: '12345', batchName: '第一轮方案内课程', waitForBatchStart: true,
  autoStartTime: '2026-09-04 09:00:00', browserChannel: 'msedge',
  courses: [
    { name: '高数', menu: '推荐班级课程', teachers: ['张', '李'] },
    { name: '体育', menu: '体育俱乐部', priorities: [{ keywords: ['足球'], teacher: '王' }] },
  ],
};
const out = buildConfigFromAnswers(base, ans);
assert.strictEqual(out.username, '12345');
assert.deepStrictEqual(out.interfaceOrder, ['plan']);
assert.strictEqual(out.batches.plan.name, '第一轮方案内课程');
assert.deepStrictEqual(out.batches.plan.courses[0], { name: '高数', menu: '推荐班级课程', teacher: ['张', '李'] });
assert.strictEqual(out.batches.plan.courses[0].priority, undefined);
assert.deepStrictEqual(out.batches.plan.courses[1], { name: '体育', menu: '体育俱乐部', priority: [{ keywords: ['足球'], teacher: '王' }] });
assert.strictEqual(out.batches.general.name, 'g');
assert.strictEqual(out.timing.autoStartTime, '2026-09-04 09:00:00');
assert.strictEqual(out.browser.channel, 'msedge');
assert.strictEqual(out.browser.profileDir, '.browser-profile');
console.log('wizard config checks passed');
