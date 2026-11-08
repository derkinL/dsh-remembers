/**
 * 确定性「人味」后处理（照 dsh-fish-tone 的 fish_flavor，MIT）。
 *
 * 不调模型，纯规则：同一段输入永远同一段输出，可单测。
 * 只做「不会改坏意思」的四件事：
 *   1) 重复标点压缩：「。。」→「。」「!!!」→「！」；超过三个问号压到三个
 *   2) 破折号换逗号：「——」→「，」（句首的不动）
 *   3) 句尾挂一个没用的尾巴（cute/abstract 两档，密度很低，只挑判断句）
 *   4) 去掉句尾多余空格
 *
 * 跳过：代码块、行内代码、URL、路径、表格行、以数字/单位结尾的判断之外的句子。
 */

const CUTE = ['呀', '嘛', '啦', '哟', '哦', '呢'];
const ABSTRACT = ['典', '绝了', '离谱', '这很难评', '就这', '笑死', '已阅'];

const JUDGE_RE = /(有点|挺|太|真的|感觉|觉得|拖|尬|难评|一般|不错|还行|离谱)/;

/** 段落级跳过：代码块 / 表格 / 引用 */
function isSkippable(block) {
  const t = block.trim();
  if (!t) return true;
  if (t.startsWith('```')) return true;
  if (t.startsWith('|')) return true;
  if (t.startsWith('>')) return true;
  if (/^\s*[-*+]\s/.test(t)) return true;   // 列表
  if (/^#{1,6}\s/.test(t)) return true;     // 标题
  return false;
}

/** 一行里跳过行内代码 / URL */
function stripProtectedRanges(line) {
  const keep = [];
  let masked = line;
  const push = (re) => {
    masked = masked.replace(re, (m) => {
      keep.push(m);
      return '\u0000';
    });
  };
  push(/`[^`]*`/g);
  push(/https?:\/\/\S+/g);
  push(/[A-Za-z]:\\[^\s]+/g);
  return { masked, keep };
}

function restoreProtected(line, keep) {
  let i = 0;
  return line.replace(/\u0000/g, () => keep[i++] ?? '');
}

/** 1) 重复标点 + 2) 破折号 */
function tidyPunct(text) {
  let out = text;
  const changes = [];

  out = out.replace(/([，,]){2,}/g, (m) => { changes.push('压逗号'); return '，'; });
  out = out.replace(/([。.]){2,}/g, (m) => { changes.push('压句号'); return '。'; });
  out = out.replace(/！{2,}/g, () => { changes.push('压感叹号'); return '！'; });
  out = out.replace(/？{4,}/g, () => { changes.push('压问号'); return '？？？'; });
  out = out.replace(/[ \t]+$/gm, '');

  // 破折号换逗号：只处理句中（前面还有字的）
  out = out.replace(/(?<=[\u4e00-\u9fa5])——(?=[\u4e00-\u9fa5])/g, () => {
    changes.push('破折号→逗号');
    return '，';
  });
  return { text: out, changes };
}

/** 3) 句尾尾巴：只挑「判断句」，整段最多一处 */
function addTail(text, mode, rnd) {
  if (mode !== 'cute' && mode !== 'abstract') return { text, added: null };
  const paras = text.split(/\n{2,}/);
  for (let pi = paras.length - 1; pi >= 0; pi--) {
    const para = paras[pi];
    if (isSkippable(para)) continue;
    const lines = para.split('\n');
    for (let li = lines.length - 1; li >= 0; li--) {
      const raw = lines[li];
      if (!raw.trim()) continue;
      const m = raw.match(/^(.*?)([。！？!?])?$/s);
      const body = (m[1] || '').trim();
      const punct = m[2] || '';
      if (!body) continue;
      if (!JUDGE_RE.test(body)) continue;
      if (/\d$/.test(body)) continue;
      if (/[）)」』”"]$/.test(body)) continue;
      const pool = mode === 'cute' ? CUTE : ABSTRACT;
      const pick = pool[Math.floor(rnd() * pool.length)];
      const tail = (mode === 'cute' ? '' : '，') + pick;
      lines[li] = body + tail + punct;
      paras[pi] = lines.join('\n');
      return { text: paras.join('\n\n'), added: tail };
    }
  }
  return { text, added: null };
}

/**
 * @param {string} text
 * @param {{mode?: 'none'|'cute'|'abstract', seed?: number}} opts
 * @returns {{text: string, changes: string[], tail: string|null}}
 */
export function fixTone(text, opts = {}) {
  const mode = opts.mode || 'none';
  let s = String(text || '');
  if (!s.trim()) return { text: s, changes: [], tail: null };

  const { masked, keep } = stripProtectedRanges(s);
  const t1 = tidyPunct(masked);
  const rnd = (() => {
    let x = Number(opts.seed || 20261108) || 1;
    return () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x / 0x7fffffff;
    };
  })();
  const t2 = addTail(t1.text, mode, rnd);
  const finalText = restoreProtected(t2.text, keep);

  return { text: finalText, changes: Array.from(new Set(t1.changes)), tail: t2.added };
}
