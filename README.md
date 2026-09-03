# xsxk-autoselect

西电选课系统自动选课助手（个人自用脚本）。

自动完成「方案内课程」的抢课：进入选课页、搜索/定位课程行、展开教学班、按教师/关键词优先级选择、点确认、判定是否真选上、失败重试、断点续跑。

> 登录（含验证码）由使用者在浏览器里**手动完成**。脚本不收集、不保存、不发送任何账号凭证。

## 功能

- 按 `config` 顺序逐门抢课（正选排队制，点了并确认即进队，不重复提交）
- 教师 / 关键词优先级选择教学班
- 服务器时钟校准 + 开点前 10s 硬临界（零网络、秒级出手）
- 等待期保活、掉线自动提示重登、断点续跑
- 浏览器自动检测：Edge → Chrome → Chromium
- 交互式配置向导 + 一键启动

## 使用

需要 Node.js（>=16），并在项目目录安装依赖：

```bash
npm install
cp config.example.json config.json   # 然后用编辑器或向导填写你的课程
node configure.js                    # 交互式向导，生成 config.json
node select.js                       # 按配置抢课
```

Windows 可直接双击 `一键启动.bat`（自动装依赖、首次引导配置、然后抢课）。

## 配置

参照 `config.example.json`。关键项：

- `batches.plan.courses`：方案内课程清单（`name` / `menu` / `priority` 或旧字段 `section`、`teacher`、`clubPriority`）
- `timing.autoStartTime`：开点时间（脚本等待到点再出手）
- `browser`：浏览器类型（`channel` / `executablePath`，留空自动检测）

## 测试

```bash
npm test
```

## 免责声明

- 本脚本仅供学习与个人自动化使用，请遵守所在学校的规定与选课系统使用条款。
- 选课系统的验证码用于阻止机器人，请保持人工完成登录验证。
- 使用本脚本造成的任何后果由使用者自行承担。

## License

MIT
