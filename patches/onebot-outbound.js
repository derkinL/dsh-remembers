/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / plain
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitChatId } from './chat.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { extractForwardBlocks, scanSensitive, stripMarkdown } from './split.js';
import { renderTextImage } from './t2i/index.js';
import { describeError } from './errors.js';
import { TRACE_REASONS } from './trace.js';
/** Split a reply into chat-sized pieces at CJK/ASCII sentence boundaries.
 * Used when config.sentenceSplit is on: each piece is sent as its own
 * message with a short gap, so a long reply reads like a human typing. */
function splitSentences(text) {
    // 2026-11-08 修：不能在有引号的地方断句。
    // 原来的写法 `split(/(?<=[。！？!?…~～])/)` 会在「不是单身安澜？」的 ？ 处切开，
    // 于是最后一条消息成了孤零零的「」」加后面那句（线上真发出来了）。
    // 现在逐字走，只在「引号/括号都闭合」时才允许断。
    const OPEN = { '「': '」', '『': '』', '“': '”', '（': '）', '(': ')', '【': '】' };
    const CLOSE = new Set(Object.values(OPEN));
    const ENDERS = new Set(['。', '！', '？', '!', '?', '…', '~', '～']);
    const paragraphs = text.split(/\n{2,}/u);
    const raw = [];
    for (const para of paragraphs) {
        let buf = '';
        const stack = [];
        for (const ch of para) {
            if (OPEN[ch]) {
                stack.push(OPEN[ch]);
            }
            else if (CLOSE.has(ch)) {
                if (stack[stack.length - 1] === ch)
                    stack.pop();
            }
            buf += ch;
            if (ENDERS.has(ch) && stack.length === 0) {
                raw.push(buf);
                buf = '';
            }
        }
        if (buf.trim() !== '')
            raw.push(buf);
    }
    const pieces = [];
    for (const part of raw) {
        const t = part.trim();
        if (t === '')
            continue;
        const last = pieces[pieces.length - 1];
        // 碎片合并：太短的；或者以右引号/右括号开头的（说明被断在了引号中间）
        const orphan = /^[」』”"）)】]/u.test(t);
        if (last !== undefined && (t.length < 4 || last.length < 4 || orphan)) {
            pieces[pieces.length - 1] = last + t;
        }
        else {
            pieces.push(t);
        }
    }
    return pieces;
}

/** Remove roleplay-style action/scene descriptions from a reply.
 * Immersive chat should be dialogue only: （尾巴一甩）(smiles)【叹气】
 * and full-width bracket scenery are stripped before sending. */
function stripActions(text) {
    // 只删「动作 / 旁白」，别把颜文字一起删了。
    //
    // 原来的写法是 （...）/【...】/(...) 一律清空 —— 颜文字 (￣▽￣)、(¬‿¬)
    // 恰好也是半角括号包起来的，于是全被吃掉。人格里明写着「可以使用文字颜
    // 来代表自己的情绪」，结果她说得出来、发不出去。
    //
    // 判据（只看括号里面）：
    //   含汉字            -> 动作（打了个哈欠）/（尾巴一甩），删
    //   含两个以上英文     -> 动作 (smiles) / (laughs)，删
    //   其余（纯符号/假名/希腊字母/单字母）-> 颜文字，原样保留
    const isAction = (inner) => {
        const s = String(inner == null ? '' : inner);
        return /[\u4e00-\u9fa5]/.test(s) || /[A-Za-z]{2,}/.test(s);
    };

    // 用命名分组，免得再用位置参数对不上（上一版就是这么错位的）
    return text
        .replace(/（(?<a>[^）]{0,120})）/g, (m, inner) => (isAction(inner) ? '' : m))
        .replace(/【(?<a>[^】]{0,120})】/g, (m, inner) => (isAction(inner) ? '' : m))
        .replace(/\((?<a>[^)]{0,120})\)/g, (m, inner) => (isAction(inner) ? '' : m))
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/** Remove harness/plugin markup that the model sometimes echoes as plain text.
 *
 * 线上见过三种泄漏，全都是「模型把上下文里的标签当成自己要说的话」：
 *   </usermessage> <usermessage qq="123" nickname="…">   —— 宿主包装
 *   <dsh-remembers source="state">…</dsh-remembers>       —— 插件注入块
 *   </DSML> <||DSML||invoke> <||DSML||parameter …>        —— 工具调用语法
 * 这些东西绝对不能发到 QQ：用户看到就是一串 XML。 */
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

/** Gap between split messages (ms) — feels like typing. */
const SENTENCE_SPLIT_GAP_MIN_MS = 1500;
const SENTENCE_SPLIT_GAP_MAX_MS = 1500;
/** Random typing pause between split messages (ms). */
function splitGapMs() {
    return SENTENCE_SPLIT_GAP_MIN_MS + Math.floor(Math.random() * (SENTENCE_SPLIT_GAP_MAX_MS - SENTENCE_SPLIT_GAP_MIN_MS + 1));
}
/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000;
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20;
/** W2-③: default bridge-wide proactive-write caps, aligned with the MIT
 * competitor's actionRatePerMinute(20) / actionRatePerDay(500). */
export const DEFAULT_ACTION_RATE_PER_MINUTE = 20;
export const DEFAULT_ACTION_RATE_PER_DAY = 500;
/** W2-③: proactive-write audit file name, appended under mediaDir (jsonl). */
export const ACTION_AUDIT_FILE = 'qq-actions.log';
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
    ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). */
    pendingSends = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        // Lazy default: read Date.now through a wrapper so an injected clock is
        // optional and callers without one keep the dynamic global lookup (fake
        // timers in tests must keep influencing the wall-clock path).
        this.now = options.now ?? (() => Date.now());
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        return this.enqueue(chatId, async () => {
            if (!this.ctx.connected()) {
                if (options.queuable === true) {
                    // pipeline-hooks.md #23: the park used to be silent.
                    this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
                    this.queuePendingSend(chatId, text);
                    return [];
                }
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected });
                throw new OneBotNotConnectedError();
            }
            const hits = scanSensitive(text, this.ctx.config.sensitivePatterns);
            if (hits.length > 0) {
                this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSensitive, data: { hits: hits.slice(0, 5) } });
            }
            const ids = [];
            const { body, nodes } = extractForwardBlocks(text, '助手');
            if (nodes.length > 0) {
                // Passive reply path: [[qq_forward]] blocks inside a turn reply are
                // NOT gated as proactive writes (see the W2-③ 口径 note).
                await this.sendForwardNodes(chatId, nodes);
                ids.push('forward');
            }
            let sentCard = false;
            const threshold = this.ctx.config.textImageThreshold;
            const sentenceSplit = this.ctx.config.sentenceSplit !== false;
            if (!sentenceSplit && threshold > 0 && body.length > threshold) {
                try {
                    const chat = this.ctx.getChat(chatId);
                    const title = chat !== undefined && chat.lastNickname !== ''
                        ? 'To ' + chat.lastNickname
                        : undefined;
                    const png = renderTextImage(body, {
                        title,
                        footerBrand: this.ctx.config.cardFooter,
                        fontFiles: this.ctx.config.fontFiles,
                        fontFamilies: this.ctx.config.fontFamilies,
                    });
                    const b64 = 'base64://' + png.toString('base64');
                    if (b64.length <= this.ctx.config.maxImageBytes) {
                        const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options);
                        if (id !== undefined)
                            ids.push(id);
                        sentCard = true;
                    }
                    else {
                        this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text');
                        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundCardTooLarge });
                    }
                }
                catch (error) {
                    this.ctx.log('warn', 't2i render failed, falling back to text: ' + describeError(error));
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '文字图卡片渲染失败，已降级为文本: ' + describeError(error) });
                }
            }
            if (!sentCard) {
                const plain = stripLeakedMarkup(stripActions(stripMarkdown(body)));
                if (plain !== '') {
                    if (sentenceSplit) {
                        const pieces = splitSentences(plain);
                        const ref = splitChatId(chatId);
                        const typingUser = ref.kind === 'private' ? Number(ref.target) : undefined;
                        const setTyping = async (state) => {
                            if (typingUser === undefined || !Number.isFinite(typingUser))
                                return;
                            try {
                                await this.ctx.call('set_input_status', { user_id: typingUser, event_type: state }, chatId);
                            }
                            catch {
                                // 输入状态只是锦上添花，失败不影响发送
                            }
                        };
                        for (let i = 0; i < pieces.length; i += 1) {
                            await setTyping(1);
                            const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: pieces[i] } }], options);
                            if (id !== undefined)
                                ids.push(id);
                            if (i < pieces.length - 1) {
                                await new Promise(resolve => setTimeout(resolve, splitGapMs()));
                            }
                            else {
                                await setTyping(0);
                            }
                        }
                    }
                    else {
                        const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: plain } }], options);
                        if (id !== undefined)
                            ids.push(id);
                    }
                }
                else {
                    // pipeline-hooks.md #30: the empty-body skip used to be silent.
                    this.ctx.log('debug', '正文为空，未发送: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText });
                }
            }
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '回复已发送', data: { segments: ids.length } });
            return ids;
        });
    }
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    queuePendingSend(chatId, text) {
        const queue = this.pendingSends.get(chatId) ?? [];
        if (queue.length >= PENDING_SEND_MAX) {
            queue.shift();
            this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest');
            this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull });
        }
        queue.push({ text, sentAt: this.now() });
        this.pendingSends.set(chatId, queue);
    }
    // ── W2-③ proactive-write gate (minute/day caps + audit) ─────────────────
    // 口径（per outbound.ts structure）：「主动写」= 模型/命令经 qq_* 工具发起、
    // 不属于某个入站回合回复链的出站写 —— 即 sendSegments（qq_send_image/voice/
    // video/file/segments）与公开 sendForward（qq_send_forward）。被动回复不受此
    // 闸：sendToChat 整条链（最终回复/interim/错误与命令通知、[[qq_forward]] 块，
    // 后者走未设闸的 sendForwardNodes）由入站 rateLimitPerMinute + B6 队列上限
    // 约束。两类计数都是全桥合计（不分会话）。
    /** Sliding-60s timestamps of allowed proactive writes (bridge-wide). */
    writeActionTimes = [];
    /** Calendar-day (local) counter of allowed proactive writes. */
    writeDayKey = '';
    writeDayCount = 0;
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    auditChain = Promise.resolve();
    /** W1/T5 health snapshot: the write gate's current usage against its
     * limits (minute sliding window pruned at read time; day counter). */
    writeGateStats() {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        const now = this.now();
        const minuteUsed = perMinute > 0
            ? this.writeActionTimes.filter(t => now - t < 60_000).length
            : 0;
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const dayUsed = perDay > 0 && this.writeDayKey === dayKey ? this.writeDayCount : 0;
        return { minuteUsed, minuteLimit: perMinute, dayUsed, dayLimit: perDay };
    }
    /** W2-③: check + consume one proactive-write slot. Returns a non-empty
     * Chinese rejection reason when the write must be dropped (a warn with the
     * chatId and the limit name is logged and the rejection is audited);
     * returns null when allowed (slot consumed). Rejected attempts do not
     * consume quota. */
    writeGateRejectReason(chatId, action) {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        if (perMinute <= 0 && perDay <= 0)
            return null;
        const now = this.now();
        this.writeActionTimes = this.writeActionTimes.filter(t => now - t < 60_000);
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (this.writeDayKey !== dayKey) {
            this.writeDayKey = dayKey;
            this.writeDayCount = 0;
        }
        if (perMinute > 0 && this.writeActionTimes.length >= perMinute) {
            const reason = '写操作频率超限：60 秒内主动写已达 ' + perMinute + ' 次上限（actionRatePerMinute=' + perMinute + '），请稍后再试';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        if (perDay > 0 && this.writeDayCount >= perDay) {
            const reason = '写操作次数超限：今日主动写已达 ' + perDay + ' 次上限（actionRatePerDay=' + perDay + '），明日自动恢复';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        this.writeActionTimes.push(now);
        this.writeDayCount += 1;
        return null;
    }
    /** W2-③: append one proactive-write (or rejection / send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    auditWrite(chatId, action, ok, reason) {
        if (this.ctx.config.actionAuditEnabled === false)
            return;
        const dir = this.ctx.config.mediaDir;
        if (dir === undefined || dir === '')
            return;
        const line = JSON.stringify({ ts: this.now(), chatId, action, ok, reason }) + '\n';
        this.auditChain = this.auditChain.then(async () => {
            await mkdir(dir, { recursive: true });
            await appendFile(join(dir, ACTION_AUDIT_FILE), line, 'utf8');
        }).catch(error => {
            this.ctx.log('warn', '写操作审计写入失败: ' + describeError(error));
        });
    }
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends() {
        if (this.ctx.isStopping())
            return;
        const now = this.now();
        const batch = [];
        for (const [chatId, queue] of this.pendingSends) {
            this.pendingSends.delete(chatId);
            for (const item of queue) {
                if (now - item.sentAt < PENDING_SEND_TTL_MS) {
                    batch.push({ chatId, text: item.text });
                }
                else {
                    // pipeline-hooks.md #25: the TTL drop used to be silent.
                    this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                }
            }
        }
        for (const { chatId, text } of batch) {
            void this.sendToChat(chatId, text, { queuable: true }).catch((error) => {
                this.ctx.log('warn', 'queued resend failed: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) });
            });
        }
    }
    /**
     * Send raw OneBot segments (used by the media tools). W2-③: counts as a
     * proactive write — subject to the minute/day caps and audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.enqueue(chatId, async () => {
            const reject = this.writeGateRejectReason(chatId, 'send_msg');
            if (reject !== null)
                throw new OneBotActionError(reject);
            try {
                const id = await this.sendMsg(chatId, segments, {});
                this.auditWrite(chatId, 'send_msg', true, '发送成功');
                return id;
            }
            catch (error) {
                this.auditWrite(chatId, 'send_msg', false, '发送失败: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
                throw error;
            }
        });
    }
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    sendChains = new Map();
    /** Serialize work on one chat's send chain. */
    enqueue(chatId, work) {
        const chain = this.sendChains.get(chatId) ?? Promise.resolve();
        const run = chain.then(work, work);
        const tail = run.catch(() => undefined);
        this.sendChains.set(chatId, tail);
        void tail.then(() => {
            if (this.sendChains.get(chatId) === tail)
                this.sendChains.delete(chatId);
        });
        return run;
    }
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId) {
        return this.sendChains.get(chatId) ?? Promise.resolve();
    }
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        const ref = splitChatId(chatId);
        const params = {};
        let target;
        try {
            target = Number(ref.target);
            if (!Number.isFinite(target))
                throw new Error('bad target');
        }
        catch {
            throw new OneBotActionError('invalid chat target: ' + chatId);
        }
        if (ref.kind === 'group')
            params.group_id = target;
        else
            params.user_id = target;
        params.message = segments;
        if (options.replyTo !== undefined) {
            params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments];
        }
        const data = await this.ctx.call('send_msg', params, chatId);
        return data.message_id !== undefined ? String(data.message_id) : undefined;
    }
    /** Send [[qq_forward]] nodes as a merged-forward message (proactive write
     * from the qq_send_forward tool). W2-③: subject to the minute/day caps
     * and audited; the passive [[qq_forward]] blocks inside sendToChat bypass
     * this gate via sendForwardNodes. */
    async sendForward(chatId, nodes) {
        const reject = this.writeGateRejectReason(chatId, 'send_forward_msg');
        if (reject !== null)
            throw new OneBotActionError(reject);
        try {
            await this.sendForwardNodes(chatId, nodes);
            this.auditWrite(chatId, 'send_forward_msg', true, '发送成功');
        }
        catch (error) {
            this.auditWrite(chatId, 'send_forward_msg', false, '发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
            throw error;
        }
    }
    /** Ungated merged-forward send (shared by the gated tool path and the
     * passive [[qq_forward]] blocks inside sendToChat). */
    async sendForwardNodes(chatId, nodes) {
        const ref = splitChatId(chatId);
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        const messages = nodes.map(node => ({
            type: 'node',
            data: {
                uin: this.ctx.selfId() || this.ctx.config.botQQ,
                name: node.name.slice(0, 24),
                content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
            },
        }));
        if (ref.kind === 'group') {
            await this.ctx.call('send_forward_msg', { group_id: target, messages }, chatId);
        }
        else {
            await this.ctx.call('send_private_forward_msg', { user_id: target, messages }, chatId);
        }
    }
}

export { splitSentences };
