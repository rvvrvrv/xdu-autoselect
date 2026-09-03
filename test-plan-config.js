const assert = require('assert');
const { resolvePlanCourse } = require('./select');

assert.deepStrictEqual(
  resolvePlanCourse({
    name: '高等数学',
    menu: '推荐班级课程',
    priority: [{ teacher: '张老师' }, { keywords: ['周二'] }],
  }),
  {
    menuLabel: '推荐班级课程',
    priority: [{ teacher: '张老师' }, { keywords: ['周二'] }],
    teacher: '',
  },
);

assert.deepStrictEqual(
  resolvePlanCourse({
    name: '大学体育',
    section: 'sportsClub',
    teacher: '王老师',
    clubPriority: [{ keywords: ['足球'] }],
  }),
  {
    menuLabel: '体育俱乐部',
    priority: [{ keywords: ['足球'] }],
    teacher: '王老师',
  },
);

assert.deepStrictEqual(
  resolvePlanCourse({ name: '大学英语中级', teacher: ['张老师', '肖老师'] }),
  {
    menuLabel: '推荐班级课程',
    priority: null,
    teacher: ['张老师', '肖老师'],
  },
);

console.log('plan config checks passed');
