import { fixTone } from '../tools/tone.js';
import assert from 'node:assert';

const cases = [
  ['这段有点拖。。', 'none', '压逗号/句号'],
  ['好！！！！', 'none', '压感叹号'],
  ['为什么？？？？？', 'none', '压问号到三个'],
  ['配乐不错——就是后面有点拖', 'none', '破折号换逗号'],
  ['这段有点拖。', 'cute', 'cute 挂尾巴'],
  ['配乐不错，就是后面有点拖。', 'abstract', 'abstract 挂尾巴'],
  ['```js\nconst a = 1。\n```', 'none', '代码块不动'],
  ['看这个 https://x.com/a。。', 'none', 'URL 保留，标点照压'],
  ['| 表 | 格 |\n| --- | --- |', 'none', '表格不动'],
  ['今天11点。', 'cute', '数字结尾不加尾巴'],
];

for (const [input, mode, why] of cases) {
  const r = fixTone(input, { mode });
  console.log('[' + why + ']');
  console.log('  in :', JSON.stringify(input));
  console.log('  out:', JSON.stringify(r.text), '| changes:', r.changes.join(','), '| tail:', r.tail);
}

// 断言
const a = fixTone('这段有点拖。。');
assert.ok(!a.text.includes('。。'), '重复句号没压');
const b = fixTone('为什么？？？？？');
assert.equal((b.text.match(/？/g) || []).length, 3, '问号应压到 3 个');
const c = fixTone('配乐不错，就是后面有点拖。', { mode: 'abstract' });
assert.ok(c.tail, 'abstract 没挂尾巴');
const d = fixTone('```\n代码。\n```', { mode: 'cute' });
assert.equal(d.tail, null, '代码块不该挂尾巴');
const e = fixTone('今天11点。', { mode: 'cute' });
assert.equal(e.tail, null, '数字结尾不该挂尾巴');
console.log('\n全部断言通过');
