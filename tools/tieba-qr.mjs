/**
 * tools/tieba-qr.mjs —— 贴吧扫码登录（百度 passport 的扫码流程）
 *
 * 这不是官方开放接口，是百度 passport 网页登录用的那套：
 *   getqrcode → 显示二维码 → unicast 轮询 → 扫完给一个 v 链接 → GET 它拿到 BDUSS
 *
 * 状态落在 TIEBA_DIR：
 *   qr-jar.txt   curl 的 cookie jar（扫码过程中的 BAIDUID 等）
 *   qr-state.json 当前二维码的 sign / 时间
 *
 * 拿到 BDUSS 后直接调 tieba.js 的 setCookie() 写进 cookie.txt，跟手填完全等价。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { setCookie } from './tieba.js'

const BASE = 'https://passport.baidu.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function dir() {
  if (process.env.TIEBA_DIR) return process.env.TIEBA_DIR
  const h = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(h, 'tieba-duty')
}
const jarPath = () => path.join(dir(), 'qr-jar.txt')
const statePath = () => path.join(dir(), 'qr-state.json')

function curl(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl', args)
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err) }))
  })
}

function parseJsonp(text) {
  const raw = String(text || '').trim()
  if (!raw) return {}
  // 有的接口带 callback（JSONP），有的直接给 JSON，两种都认
  try { return JSON.parse(raw) } catch { /* 继续试 JSONP */ }
  const i = raw.indexOf('(')
  const j = raw.lastIndexOf(')')
  if (i < 0 || j <= i) return {}
  try { return JSON.parse(raw.slice(i + 1, j)) } catch { return {} }
}

function readJarCookie(name) {
  try {
    const lines = fs.readFileSync(jarPath(), 'utf8').split('\n')
    for (const l of lines) {
      const cols = l.split('\t')
      if (cols.length >= 7 && cols[5] === name) return cols[6].trim()
    }
  } catch { /* 没有 jar */ }
  return ''
}

const gid = () => crypto.randomBytes(16).toString('hex').toUpperCase()

/** 生成二维码：返回 { sign, img(dataURL) } */
export async function qrStart() {
  fs.mkdirSync(dir(), { recursive: true })
  try { fs.unlinkSync(jarPath()) } catch { /* 新一轮 */ }
  const q = new URLSearchParams({
    lp: 'pc', qrloginfrom: 'pc', gid: gid(),
    callback: 'tangram_guid_callback', apiver: 'v3', tt: String(Date.now()), tpl: 'netdisk',
  })
  const r = await curl(['-s', '-m', '15', '-A', UA, '-c', jarPath(), '-b', jarPath(),
    `${BASE}/v2/api/getqrcode?${q.toString()}`])
  const j = parseJsonp(r.out.toString('utf8'))
  if (!j.sign) throw new Error('取二维码失败：' + r.out.toString('utf8').slice(0, 160))

  // imgurl 有时带 scheme，有时是 "passport.baidu.com/v2/api/qrcode?..."
  let imgPath = String(j.imgurl || '')
  imgPath = imgPath.replace(/^https?:\/\/[^/]+/i, '').replace(/^passport\.baidu\.com/i, '')
  if (!imgPath.startsWith('/')) imgPath = '/' + imgPath
  const imgUrl = BASE + imgPath
  const img = await curl(['-s', '-m', '15', '-A', UA, '-H', 'Referer: https://passport.baidu.com/',
    '-b', jarPath(), '-c', jarPath(), imgUrl])
  if (img.code !== 0 || img.out.length < 200) throw new Error('二维码图片没取到')

  fs.writeFileSync(statePath(), JSON.stringify({ sign: j.sign, at: Date.now() }), 'utf8')
  return { sign: j.sign, img: 'data:image/png;base64,' + img.out.toString('base64') }
}

/** 轮询：waiting / scanned / done / expired */
export async function qrPoll() {
  let st = {}
  try { st = JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { /* 没开始 */ }
  if (!st.sign) return { ok: false, status: 'none', error: '还没生成二维码' }
  if (Date.now() - Number(st.at || 0) > 5 * 60 * 1000) return { ok: false, status: 'expired', error: '二维码过期了，重新生成' }

  const q = new URLSearchParams({
    channel_id: st.sign, tpl: 'netdisk', apiver: 'v3',
    tt: String(Date.now()), callback: 'tangram_guid_callback',
  })
  const r = await curl(['-s', '-m', '15', '-A', UA, '-b', jarPath(), '-c', jarPath(),
    `${BASE}/v2/api/unicast?${q.toString()}`])
  const j = parseJsonp(r.out.toString('utf8'))
  if (!j.channel_v) return { ok: true, status: 'waiting' }

  let v
  try { v = JSON.parse(j.channel_v) } catch { return { ok: true, status: 'waiting' } }
  if (Number(v.status) !== 0) return { ok: true, status: 'scanned' }
  if (!v.v) return { ok: false, status: 'error', error: '扫码成功但没给跳转地址' }

  const r2 = await curl(['-s', '-L', '-m', '20', '-A', UA, '-b', jarPath(), '-c', jarPath(), String(v.v)])
  if (r2.code !== 0) return { ok: false, status: 'error', error: '换 BDUSS 的请求失败' }
  const bduss = readJarCookie('BDUSS')
  if (!bduss) return { ok: false, status: 'error', error: '换到了跳转页，但没拿到 BDUSS' }
  setCookie('BDUSS=' + bduss)
  try { fs.unlinkSync(statePath()) } catch { /* 用完清掉 */ }
  return { ok: true, status: 'done' }
}
