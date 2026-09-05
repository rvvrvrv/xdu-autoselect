'use strict';
/**
 * lib/course-catalog.js —— 课程目录的纯函数处理（供 configure.js 抓取向导使用，便于单测）
 *
 * 数据形态（由浏览器端 evaluate 抓出）：
 * {
 *   batchName, batchCode,
 *   courses: [ { menu, name, code, chosen, raw,
 *                classes: [ { seq, teacher, club, place, capacity, selected,
 *                             conflict, chosen, disabled, raw } ] } ]
 * }
 */

/** 卡片头部 title 形如 "[24]刘倩" 或 "[142]-基础体能俱乐部]田嘉鑫" */
function parseCardTitle(title) {
  const m = String(title || '').replace(/\s+/g, '').match(/^\[(\d+)\](.*)$/);
  if (!m) return { seq: '', teacher: '', club: '' };
  const rest = m[2];
  const i = rest.lastIndexOf(']');
  if (i >= 0) return { seq: m[1], club: rest.slice(0, i), teacher: rest.slice(i + 1) };
  return { seq: m[1], club: '', teacher: rest };
}

/** 从卡片/行的纯文本中解析容量与已选人数（文本已去空白） */
function parseCapacity(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const cap = t.match(/课容量[:：]?(\d+)/);
  const sel = t.match(/已选人数[:：]?(\d+)/);
  return { capacity: cap ? Number(cap[1]) : null, selected: sel ? Number(sel[1]) : null };
}

/** 从上课时间地点文本提取一个可用于 keywords 的判别词（优先星期几） */
function placeKeyword(place) {
  const m = String(place || '').match(/星期[一二三四五六日天]/);
  return m ? m[0] : '';
}

/** 规整一张教学班卡片（raw 由浏览器端抓取的原始字段组成） */
function normalizeClass(raw) {
  const title = parseCardTitle(raw.title);
  const cap = parseCapacity(raw.text);
  return {
    seq: title.seq,
    teacher: title.teacher,
    club: title.club,
    place: String(raw.place || '').replace(/\s+/g, ' ').trim(),
    capacity: cap.capacity,
    selected: cap.selected,
    conflict: !!raw.conflict,
    chosen: !!raw.chosen,
    disabled: !!raw.disabled,
    raw: String(raw.text || '').replace(/\s+/g, ' ').trim(),
  };
}

/** 生成展示用的教学班一行文本 */
function formatClass(c, idx) {
  const cap = c.capacity != null ? `容量${c.capacity}` : '容量?';
  const sel = c.selected != null ? `已选${c.selected}` : '已选?';
  const flags = [
    c.chosen ? '✓已选' : '',
    c.conflict ? '⚠冲突' : '',
    c.disabled || (c.capacity != null && c.selected != null && c.selected >= c.capacity) ? '满' : '',
  ].filter(Boolean).join('/');
  return `[${idx}] ${c.teacher || '(未知教师)'}${c.seq ? ' [' + c.seq + ']' : ''}  ${c.place || ''}  ${cap}/${sel}${flags ? '  ' + flags : ''}`;
}

/** 生成整个目录的编号列表文本 */
function formatCatalog(catalog) {
  const lines = [];
  let n = 0;
  const index = [];
  for (const course of catalog.courses || []) {
    n += 1;
    const flags = [
      course.chosen ? '✓已选' : '',
      course.classes.length ? `${course.classes.length}个教学班` : '无教学班',
    ].filter(Boolean).join('，');
    lines.push(`[${n}] ${course.name}  （${course.menu}${flags ? '，' + flags : ''}）`);
    index.push({ idx: n, course });
  }
  return { text: lines.join('\n'), index };
}

/**
 * 由用户选择构建 select.js 认的课程配置：
 *   picks = [{ course, classIdx: [依优先序的教学班序号] }]
 * 同一教师多个班时自动把“星期X”加进 keywords 以便区分。
 */
function buildCourseConfig(picks) {
  const out = [];
  for (const pick of picks || []) {
    const course = pick.course;
    const priority = [];
    for (const ci of pick.classIdx || []) {
      const c = course.classes[ci - 1];
      if (!c) continue;
      const entry = { teacher: c.teacher };
      const dup = course.classes.filter((x) => x.teacher === c.teacher).length > 1;
      const kw = placeKeyword(c.place);
      if (dup && kw) entry.keywords = [kw];
      priority.push(entry);
    }
    const cfg = { name: course.name, menu: course.menu };
    if (priority.length) cfg.priority = priority;
    else if (!course.chosen) continue; // 没挑班也没已选，跳过
    out.push(cfg);
  }
  return out;
}

module.exports = { parseCardTitle, parseCapacity, placeKeyword, normalizeClass, formatClass, formatCatalog, buildCourseConfig };
