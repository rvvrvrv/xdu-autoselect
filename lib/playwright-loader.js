'use strict';
const path = require('path');
const { execSync } = require('child_process');

/**
 * 解析 playwright-core，顺序：
 *   1) config.browser.playwrightPath（显式指定）
 *   2) 本地 node_modules
 *   3) 全局 npm root
 * 不再硬编码任何人的本机路径，便于分享到其它机器。
 */
function loadPlaywright(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  candidates.push('playwright-core');
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  try {
    const g = execSync('npm root -g', { encoding: 'utf8' }).toString().trim();
    for (const name of ['playwright-core', 'playwright']) {
      try { return require(path.join(g, name)); } catch (_) {}
    }
  } catch (_) {}
  throw new Error('未找到 playwright-core。请在项目目录运行 npm install，或在 config.json 的 browser.playwrightPath 指定路径。');
}

module.exports = { loadPlaywright };
