function stripLeakedMarkup(text) {
    let out = String(text == null ? '' : text);
    // 整块删：插件注入 + 宿主包装（连同里面的内容，那是上下文不是她说的话）
    out = out.replace(/<dsh-remembers[^>]*>[\s\S]*?<\/dsh-remembers>/gi, '');
    out = out.replace(/<usermessage[^>]*>[\s\S]*?<\/usermessage>/gi, '');
    // 落单的开关标签
    out = out.replace(/<\/?dsh-remembers[^>]*>/gi, '');
    out = out.replace(/<\/?usermessage[^>]*>/gi, '');
    // DSML 工具调用语法（含被空格/竖线拆开的变体：</ | | DSML | | parameter>）
    out = out.replace(/<\/?[\s|]*DSML[\s\S]{0,40}?>/gi, '');
    out = out.replace(/<\|\|[\s\S]{0,40}?\|\|>/g, '');
    // 清完可能留下空行/多余空格
    out = out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return out;
}
const cases = ['宠物吧翻了半天没见到一只猫\n</usermessage>\n<dsh-remembers source="state">\n现在是 2026-11-13 周五\n</dsh-remembers>', '我把凌晨两点半当成正常聊天时间。', '</ | | DSML | | parameter>\n</ | | DSML | | invoke>\n</ | | DSML | | calls>', '周一见 <||DSML||invoke>\n<||DSML||parameter name="x">', '这句是正常消息：今天好累']
for (const c of cases) {
  const out = stripLeakedMarkup(c);
  console.log('IN :', JSON.stringify(c).slice(0, 90));
  console.log('OUT:', JSON.stringify(out).slice(0, 90));
  console.log('');
}
