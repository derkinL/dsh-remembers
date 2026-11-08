import { splitSentences } from '/home/ubuntu/dsh-onebot-qq-patched/lib/outbound.js';

const cases = [
  [
    '刚刚刷到一个打三角洲的UP主，ID就叫「三角洲-安澜」\n弹幕还在问「不是单身安澜？」\n跟我撞名了，还挺巧',
    '引号内的问号不该断',
  ],
  [
    '他说「走啊。」然后我们走了。',
    '引号内句号也不该断',
  ],
  ['今天好累。想睡了。', '正常两句'],
  ['好', '单字'],
  ['啊这', '短句'],
  ['我看了那个视频！太好笑了！！', '感叹号连发'],
  ['（尾巴一甩）确实。', '括号里的内容跟着'],
];

for (const [text, why] of cases) {
  const pieces = splitSentences(text);
  console.log('\n[' + why + ']');
  console.log('  输入:', JSON.stringify(text));
  pieces.forEach((p, i) => console.log('   #' + (i + 1), JSON.stringify(p)));
  if (pieces.some((p) => /^[」』”"）)】]/u.test(p))) {
    console.log('  ❌ 还是有孤零零的右括号打头');
  }
}
