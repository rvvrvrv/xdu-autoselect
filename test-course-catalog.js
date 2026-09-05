const assert = require('assert');
const {
  parseCardTitle, parseCapacity, placeKeyword, normalizeClass,
  formatCatalog, buildCourseConfig,
} = require('./lib/course-catalog');

/* 卡片标题解析 */
assert.deepStrictEqual(parseCardTitle('[24]刘倩'), { seq: '24', teacher: '刘倩', club: '' });
assert.deepStrictEqual(parseCardTitle('[24]]刘倩'), { seq: '24', teacher: '刘倩', club: '' });
assert.deepStrictEqual(parseCardTitle('[142]-基础体能俱乐部]田嘉鑫'), { seq: '142', teacher: '田嘉鑫', club: '-基础体能俱乐部' });
assert.deepStrictEqual(parseCardTitle(''), { seq: '', teacher: '', club: '' });

/* 容量/已选解析（含全角冒号与空白变体） */
assert.deepStrictEqual(parseCapacity('课容量: 40人 已选人数： 39'), { capacity: 40, selected: 39 });
assert.deepStrictEqual(parseCapacity('  课容量：53 人  已选人数：21  '), { capacity: 53, selected: 21 });
assert.deepStrictEqual(parseCapacity('没有数字'), { capacity: null, selected: null });

/* 时间判别词 */
assert.strictEqual(placeKeyword('2周,5-16周 星期五 5-6节'), '星期五');
assert.strictEqual(placeKeyword('信远I-111'), '');

/* 卡片规整：title+text → 结构化 */
const cls = normalizeClass({
  title: '[142]-基础体能俱乐部]田嘉鑫',
  place: '2周,5-16周 星期五 5-6节',
  text: '课容量: 40人\n已选人数： 39  课程冲突',
  conflict: true, chosen: false, disabled: false,
});
assert.strictEqual(cls.teacher, '田嘉鑫');
assert.strictEqual(cls.seq, '142');
assert.strictEqual(cls.capacity, 40);
assert.strictEqual(cls.selected, 39);
assert.strictEqual(cls.conflict, true);
assert.strictEqual(cls.chosen, false);

/* 目录列表格式化 */
const cat = {
  courses: [
    { menu: '推荐班级课程', name: '大学物理(Ⅱ)', classes: [{ teacher: '刘倩', seq: '24', place: '星期三 5-6节', capacity: 53, selected: 21 }] },
    { menu: '体育俱乐部', name: '大学体育(Ⅲ)', chosen: true, classes: [] },
  ],
};
const { text, index } = formatCatalog(cat);
assert.ok(/\[1\] 大学物理\(Ⅱ\)/.test(text));
assert.ok(/\[2\] 大学体育\(Ⅲ\)/.test(text));
assert.strictEqual(index.length, 2);
assert.strictEqual(index[0].course.name, '大学物理(Ⅱ)');

/* 生成 select.js 课程配置：优先级顺序 + 同教师多班时注入星期 keyword */
const course = {
  name: '大学体育(Ⅲ)', menu: '体育俱乐部',
  classes: [
    { teacher: '田嘉鑫', place: '2周,5-16周 星期五 5-6节', capacity: 40, selected: 39 },
    { teacher: '田嘉鑫', place: '2周,5-16周 星期三 5-6节', capacity: 40, selected: 20 },
    { teacher: '宋冬', place: '2周,5-16周 星期五 5-6节', capacity: 41, selected: 40 },
  ],
};
const cfg = buildCourseConfig([{ course, classIdx: [2, 3] }]);
assert.strictEqual(cfg.length, 1);
assert.strictEqual(cfg[0].name, '大学体育(Ⅲ)');
assert.strictEqual(cfg[0].menu, '体育俱乐部');
assert.deepStrictEqual(cfg[0].priority, [
  { teacher: '田嘉鑫', keywords: ['星期三'] },
  { teacher: '宋冬' },
]);

/* 未挑教学班 → 不生成（避免空配置） */
assert.deepStrictEqual(buildCourseConfig([{ course, classIdx: [] }]), []);

console.log('course catalog checks passed');
