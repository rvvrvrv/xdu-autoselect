'use strict';

/** 归一化浏览器配置；空值表示让脚本自动探测，兼容旧配置。 */
function normalizeBrowser(b = {}, defaults = {}) {
  const headless = typeof b.headless === 'boolean'
    ? b.headless
    : (typeof defaults.headless === 'boolean' ? defaults.headless : false);
  return {
    channel: b.channel || defaults.channel || '',
    executablePath: b.executablePath || defaults.executablePath || '',
    headless,
    profileDir: b.profileDir || defaults.profileDir || '.edge-profile',
  };
}

/**
 * 产出浏览器启动候选，按优先级排序：
 *   executablePath > channel > 自动探测（Edge → Chrome → Chromium）。
 * 返回的是可直接传给 launchPersistentContext 的选项数组。
 */
function browserCandidates(norm) {
  if (norm.executablePath) return [{ executablePath: norm.executablePath }];
  if (norm.channel) return [{ channel: norm.channel }];
  return ['msedge', 'chrome', 'chromium'].map((channel) => ({ channel }));
}

module.exports = { normalizeBrowser, browserCandidates };
