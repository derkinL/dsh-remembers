#!/usr/bin/env node
/**
 * tools/tieba-cli.mjs —— 贴吧命令行（给服务端调，也方便手动排查）
 *
 * 用法：
 *   node tieba-cli.mjs whoami
 *   node tieba-cli.mjs login   --bduss "<BDUSS 的值>"
 *   node tieba-cli.mjs browse  --kw 显卡 --pn 0
 *   node tieba-cli.mjs read    --tid 123456 --pn 1 [--max-floors 30]
 *   node tieba-cli.mjs sub     --tid 123456 --pid 789 [--pn 1]
 *   node tieba-cli.mjs reply   --kw 显卡 --tid 123456 --content "……"
 *   node tieba-cli.mjs sign    --kw 显卡
 *
 * 约定：成功打一行 JSON 到 stdout；失败打 {"ok":false,"error":"…"} 到 stdout 并 exit 1。
 * 网络层是移植过来的 lib/tieba.js（MIT，见 LICENSE-tieba-dive）。
 */
import {
  whoami, setCookie, clearCookie, hasCookie, clearCooldown,
  listBar, readThread, getSubReplies, reply, sign, followAndSign,
  setGap,
} from './tieba.js'

const args = process.argv.slice(2)
const cmd = args[0] || 'help'

function opt(name, fallback = '') {
  const i = args.indexOf('--' + name)
  if (i < 0) return fallback
  const v = args[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 0) + '\n')
  process.exit(code)
}

const gap = Number(opt('gap', '1200'))
if (Number.isFinite(gap)) setGap(gap)

try {
  if (cmd === 'whoami') {
    const me = await whoami()
    out({ ok: true, ...me })
  } else if (cmd === 'login') {
    const bduss = opt('bduss')
    setCookie(bduss)
    const me = await whoami()
    out({ ok: true, ...me })
  } else if (cmd === 'logout') {
    clearCookie()
    out({ ok: true, cleared: true })
  } else if (cmd === 'reset') {
    clearCooldown()
    out({ ok: true, cleared: true })
  } else if (cmd === 'status') {
    out({ ok: true, hasCookie: hasCookie() })
  } else if (cmd === 'browse') {
    const kw = opt('kw')
    if (!kw) out({ ok: false, error: '缺少 --kw' }, 1)
    const r = await listBar(kw, { pn: Number(opt('pn', '0')) || 0 })
    out({ ok: true, ...r })
  } else if (cmd === 'read') {
    const tid = opt('tid')
    if (!tid) out({ ok: false, error: '缺少 --tid' }, 1)
    const r = await readThread(tid, { pn: Number(opt('pn', '1')) || 1 })
    const max = Number(opt('max-floors', '40')) || 40
    const floors = Array.isArray(r.floors) ? r.floors : []
    out({
      ok: true,
      tid: r.tid,
      title: r.title,
      kw: r.kw,
      totalFloors: floors.length,
      floors: floors.slice(0, max),
      hotFloors: r.hotFloors,
      images: r.images,
      imageCount: r.imageCount,
    })
  } else if (cmd === 'sub') {
    const tid = opt('tid'); const pid = opt('pid')
    if (!tid || !pid) out({ ok: false, error: '缺少 --tid / --pid' }, 1)
    const r = await getSubReplies(tid, pid, { pn: Number(opt('pn', '1')) || 1 })
    out({ ok: true, tid, pid, ...r })
  } else if (cmd === 'reply') {
    const kw = opt('kw'); const tid = opt('tid'); const content = opt('content')
    if (!kw || !tid || !content) out({ ok: false, error: '缺少 --kw / --tid / --content' }, 1)
    const r = await reply({ kw, tid, content })
    out({ ok: true, ...r })
  } else if (cmd === 'sign') {
    const kw = opt('kw')
    if (!kw) out({ ok: false, error: '缺少 --kw' }, 1)
    const r = await followAndSign(kw, { autoFollow: opt('follow', '1') !== '0' })
    out({ ok: true, ...r })
  } else {
    out({
      ok: false,
      error: '未知命令',
      usage: [
        'whoami', 'login --bduss <值>', 'logout', 'status',
        'browse --kw <吧名> [--pn 0]',
        'read --tid <帖子号> [--pn 1] [--max-floors 40]',
        'sub --tid <帖子号> --pid <楼层id>',
        'reply --kw <吧名> --tid <帖子号> --content <内容>',
        'sign --kw <吧名> [--follow 0]',
      ],
    }, 1)
  }
} catch (e) {
  const code = e && e.code === 'NOT_LOGIN' ? 'NOT_LOGIN' : undefined
  out({ ok: false, error: String((e && e.message) || e), code }, 1)
}
