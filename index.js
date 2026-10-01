/**
 * dsh-codex-bridge —— 仅 loopback、无认证的本地 HTTP 入口。
 *
 * 最终候选 v5（2026-10-01，第四轮小修后）。相对 v4 只有四处改动：
 *  ① `enclosingTurn` 增加防御：遇到 turn/end 就清掉 open turn，
 *     孤立 user/message 不再"借用"已关闭的回合；
 *  ② `requestStateOf` 的「曾入队但 live inbox 已不持有」不再报 `canceled`，
 *     改为 `admission-pending` —— 官方先 claim inbox、再 await systemPrompt.assemble、
 *     之后才在 step 中落 user/message，存在合法的 consumed-尚未-surface 窗口，
 *     那条消息可能正在正常运行，不能当取消。只有拿到可靠撤销证据才报终态。
 *  ③ `project()`/`createProject()` 在每个 await 之间补 `assertLive()`；
 *  ④ `sendMessage` 在第二次归属检查之后补 `assertLive()` 再调用官方 prompt。
 *  已进入的 mkdir / registry.create / prompt 无法追溯撤销，契约仍是「可能完成」。
 *
 * 源码依据（安装目录 app.asar 的只读提取副本）：
 *  - dsh-agent-loop/lib/index.js:943 `turn/start` 在 turn() 开头；:1061 `user/message`
 *    在 step() 内、首次尝试前才 append ⇒ **turn/start 先于 user/message**。
 *  - 同文件 :1027-1030 `turn/end {turn, reason}`；reason 取值见
 *    dsh-tool-cordis/lib/types/api-catalog.js:7651-7668 的 TurnEndReasonMap。
 *  - 同文件 :145-150 `inbox.remove()` → `splice(target,index,1,[])`：被删消息不出现在 inserted 里。
 *  - dsh-session-projection/lib/index.js:127-132 `stateOf`（宿主状态）；
 *    :142-151 `snapshot`（**仅 wire 投影**，turnBoundary 无 wire）。
 *  - dsh-workspace/lib/index.js:406-410 `async create()`；:635-638 `async resolveByPath()`（异步）。
 *  - dsh-api-session-controller/lib/index.js:2846-2847/2971-2973/3096-3099/219-244/358-371。
 *  - dsh-host-webserver/lib/index.js:141-142 host 仅 127.0.0.1/0.0.0.0；:167-170 `get host()`。
 *
 * 零依赖：只用 `node:` 内置模块；不 import 裸包；不改 package.json。
 * 已实测：桌面 profile 自身无 node_modules/@deepseek-ai，裸包从该目录无法解析
 * （Node v24 实测 ERR_MODULE_NOT_FOUND），因此本插件坚持零裸包 import。
 */

import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export const name = 'codex-bridge';

export const inject = ['sessionController', 'workspaceRegistry', 'sessionQuery', 'webServer', 'sessionProjections', 'agents'];

export const ROUTE_PREFIX = '/local/codex-bridge';
export const PROJECT_DIR = 'D:\\AI\\WorkSpace\\Codex-DeepSeek';

const PROJECT_TITLE = 'Codex-DeepSeek';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 64 * 1024;
/** 整个请求处理的超时（不是「请求头阶段」）；超时后结果可能未知。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 413 之后最多再丢弃多少字节，避免恶意大包长期占用连接。 */
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;
const SETTLED_LIMIT = 2048;
const EVENT_TEXT_CHARS = 16 * 1024;
const MESSAGE_FIELDS = ['sessionId', 'text', 'requestId', 'clientTimeZone', 'mode'];
const CREATE_FIELDS = ['sessionId'];

function errorText(error) {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message.length > 0) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function statusForRemoteCode(code) {
  if (code === undefined) return 500;
  if (code === 'session/writer-held' || code === 'session/agent-busy' || code === 'session/conflict' || code === 'agent-preset/conflict') return 409;
  if (code === 'session/not-found') return 404;
  if (code === 'agent-preset/not-found' || code === 'workspace/not-found') return 400;
  if (code === 'gateway/bad-request' || code === 'session/invalid-time-zone' || code === 'session/attachment-invalid') return 400;
  if (code === 'gateway/cancelled') return 499;
  return 500;
}

function errorEnvelope(error) {
  const code = typeof error?.code === 'string' && error.code.includes('/') ? error.code : undefined;
  const status = Number.isSafeInteger(error?.status) ? error.status : statusForRemoteCode(code);
  return { status, body: { ok: false, ...(code === undefined ? {} : { code }), error: errorText(error) } };
}

function isLoopbackHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function parseAuthority(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return undefined;
  try {
    return new URL(`http://${hostHeader}`);
  } catch {
    return undefined;
  }
}

/** Host/Origin 围栏；Origin 比较完整 origin（协议 + host + 端口）。 */
function isTrustedLocalRequest(req) {
  const hostUrl = parseAuthority(req.headers.host);
  if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  return originUrl.protocol === 'http:' && originUrl.host === hostUrl.host;
}

/**
 * 优雅排空请求体：不立即 destroy，让 413 能真正到达客户端。
 * 超出 MAX_DRAIN_BYTES 才强制断开。
 */
export function drainRequest(req, maxBytes = MAX_DRAIN_BYTES) {
  if (req.readableEnded === true || req.destroyed === true) return;
  let seen = 0;
  const stop = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
  };
  const onData = (chunk) => {
    seen += chunk.length;
    if (seen > maxBytes) {
      stop();
      req.destroy();
    }
  };
  const onEnd = () => stop();
  const onError = () => stop();
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
}

/**
 * 读取并限制 JSON 请求体。
 * 超限时：停止累积、**不销毁套接字**，把 413 抛给响应层（由它先写响应再排空）。
 */
export function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClosed);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > limit) {
        finish(reject, httpError(413, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (received === 0) {
        finish(resolve, {});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(reject, httpError(400, 'body is not JSON'));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        finish(reject, httpError(400, 'body must be a JSON object'));
        return;
      }
      finish(resolve, parsed);
    };
    const onError = (error) => finish(reject, error);
    const onAborted = () => finish(reject, httpError(499, 'request aborted before the body was received'));
    const onClosed = () => finish(reject, httpError(499, 'connection closed before the body was received'));

    const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      finish(reject, httpError(415, 'content-type must be application/json'));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      finish(reject, httpError(413, 'request body too large'));
      return;
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClosed);
  });
}

function textOfMessage(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
  return text.length === 0 ? null : text;
}

function clipText(text) {
  if (text === null) return null;
  return text.length <= EVENT_TEXT_CHARS ? text : `${text.slice(0, EVENT_TEXT_CHARS)}…[truncated]`;
}

export function surfaceEvent(event) {
  const data = event.data;
  switch (event.type) {
    case 'user/message':
      return { role: 'user', sourceKind: data?.source?.kind, rpcId: data?.source?.rpcId ?? null, text: clipText(textOfMessage(data)) };
    case 'assistant/message':
      return { turn: data?.turn, step: data?.step, interrupted: data?.interrupted === true, text: clipText(textOfMessage(data?.message)) };
    case 'assistant/attempt':
      return { turn: data?.turn, step: data?.step, producedMessage: false };
    case 'turn/start':
      return { turn: data?.turn };
    case 'turn/end':
      return { turn: data?.turn, reason: data?.reason ?? null };
    default:
      return null;
  }
}

/** 冷会话的回合折叠（turn/start 开启，turn/end 关闭并记录 reason）。 */
export function foldTurns(events) {
  let openTurn = null;
  let lastTurn = null;
  let lastEnd = null;
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn;
      lastTurn = event.data.turn;
    } else if (event.type === 'turn/end') {
      openTurn = null;
      lastTurn = event.data.turn;
      lastEnd = { turn: event.data.turn, reason: event.data.reason ?? null, seq: event.seq };
    }
  }
  return { openTurn, lastTurn, lastEnd };
}

/** 把 TurnEndReason 归成对调用方有意义的三态。 */
export function outcomeOfReason(reason) {
  const kind = reason?.kind;
  if (kind === 'completed') return 'completed';
  if (kind === 'aborted') return 'canceled';
  if (kind === 'interrupted') return 'interrupted';
  if (kind === 'blocked' || kind === 'error') return 'failed';
  if (kind === 'max-tokens') return 'truncated';
  if (kind === 'forked') return 'forked';
  return 'unknown';
}

function assertKnownFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw httpError(400, `unknown field: ${key}`);
  }
}

/** 影响语义的字段指纹；requestId 是分组键，不进入指纹。 */
function signatureOf(fields) {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function normalizeContent(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw httpError(400, 'text must be a non-empty string');
  if (raw.length > MAX_TEXT_CHARS) throw httpError(413, `text exceeds ${String(MAX_TEXT_CHARS)} characters`);
  return [{ type: 'text', text: raw }];
}

export function validateCreate(body) {
  assertKnownFields(body, CREATE_FIELDS);
  if (body.sessionId === undefined) return { request: {} };
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) throw httpError(400, 'sessionId must be a non-empty string when present');
  return { request: { sessionId: body.sessionId } };
}

export function validateMessage(body) {
  assertKnownFields(body, MESSAGE_FIELDS);
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'sessionId is required');
  const content = normalizeContent(body.text);
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || body.requestId.length === 0)) {
    throw httpError(400, 'requestId must be a non-empty string when present');
  }
  if (body.clientTimeZone !== undefined && (typeof body.clientTimeZone !== 'string' || body.clientTimeZone.length === 0)) {
    throw httpError(400, 'clientTimeZone must be a non-empty string when present');
  }
  if (body.mode !== undefined && body.mode !== 'queue') throw httpError(400, 'mode is fixed to "queue" on this entry point');
  const requestId = body.requestId ?? randomUUID();
  const fields = { sessionId, text: content[0].text, mode: 'queue' };
  if (body.clientTimeZone !== undefined) fields.clientTimeZone = body.clientTimeZone;
  return { sessionId, requestId, content, fields, signature: signatureOf(fields) };
}

/**
 * 找出包含 admitSeq 的回合：消息之前最近一个**仍未关闭**的 turn/start。
 * 防御性处理异常历史：见到 turn/end 就清掉 open，避免孤立 user/message 借用一个已关闭的回合。
 */
function enclosingTurn(events, admitSeq) {
  let open = null;
  for (const event of events) {
    if (event.seq >= admitSeq) break;
    if (event.type === 'turn/start') open = event.data.turn;
    else if (event.type === 'turn/end') open = null;
  }
  return open;
}

/** 该回合的首个 turn/end。 */
function closingEnd(events, admitSeq, turn) {
  for (const event of events) {
    if (event.seq <= admitSeq) continue;
    if (event.type === 'turn/end' && event.data.turn === turn) return { seq: event.seq, reason: event.data.reason ?? null };
  }
  return null;
}

/**
 * 单请求状态机：unknown / admission-pending / queued / canceled → admitted → running → turn-complete。
 * 回合归属用「消息之前最近一个未关闭的 turn/start」，只认该回合的首个 turn/end；
 * 找不到所属回合时返回 unknown，不绑定任何后续回合。
 * 终态 `canceled` 只在有可靠撤销证据时返回（见下方分支）。
 */
export function requestStateOf(events, requestId, inboxHoldsRequest = null) {
  const state = { requestId, phase: 'unknown' };

  let admitSeq = -1;
  for (const event of events) {
    if (event.type === 'user/message' && event.data?.source?.rpcId === requestId) admitSeq = event.seq;
  }

  if (admitSeq === -1) {
    // 尚未出现 user/message。判定口径（第四轮小修）：
    //  - live inbox 仍持有该 requestId ⇒ queued（权威信号）；
    //  - live inbox 明确不持有，但日志证明曾经入队 ⇒ **admission-pending，不是 canceled**。
    //    官方先 claim inbox，再 await systemPrompt.assemble，之后才在 step 中落 user/message
    //    （dsh-agent-loop/lib/index.js:1061），因此存在合法的 "已被取走、尚未落盘" 窗口，
    //    那条消息可能正在正常运行；把它当取消是错误结论。
    //  - inbox 状态未知 ⇒ unknown。
    // 可靠撤销证据的现状：`inbox.remove()` 走 splice(...,1,[])，被删消息**不出现在** inserted 里
    // （同文件 :145-150），日志里无法把某次撤销归因到具体 requestId，因此首版不产出 canceled。
    if (inboxHoldsRequest === true) {
      state.phase = 'queued';
      state.detail = 'the live inbox currently holds this requestId; it has not surfaced as user/message yet';
      return state;
    }
    let everAdmitted = false;
    for (const event of events) {
      if (event.type !== 'agent/inbox/spliced') continue;
      const inserted = event.data?.inserted;
      if (!Array.isArray(inserted)) continue;
      for (const message of inserted) if (message?.source?.rpcId === requestId) everAdmitted = true;
    }
    if (inboxHoldsRequest === false) {
      state.phase = everAdmitted ? 'admission-pending' : 'unknown';
      state.detail = everAdmitted
        ? 'this requestId was recorded as inserted and the live inbox no longer holds it: it is being admitted, or it was removed (this entry point does not track inbox positions, so a removed item is not distinguished from a claimed one)'
        : 'no user/message carries this requestId and the live inbox does not hold it: never accepted, or already consumed before it could surface';
      return state;
    }
    state.detail = everAdmitted
      ? 'this requestId was recorded as inserted but there is no live inbox to confirm whether it is still pending'
      : 'no user/message and no inbox splice carries this requestId; it was never accepted, or admission is still in flight in another process';
    return state;
  }

  state.admitSeq = admitSeq;
  const turn = enclosingTurn(events, admitSeq);
  if (turn === null) {
    state.detail = 'a user/message exists without an open turn/start before it; history is not coherent enough to attribute a turn';
    return state;
  }
  state.turn = turn;

  const end = closingEnd(events, admitSeq, turn);
  if (end === null) {
    state.phase = 'running';
    return state;
  }
  state.phase = 'turn-complete';
  state.endSeq = end.seq;
  state.reason = end.reason;
  state.outcome = outcomeOfReason(end.reason);
  return state;
}

/**
 * 只分析本次回合范围内的重试与失败。
 * 无 turn 时返回 null，绝不把全部历史当成当前状态。
 */
export function failureOf(events, requestState) {
  if (typeof requestState?.turn !== 'number') return null;
  const from = requestState.admitSeq ?? -1;
  const to = requestState.endSeq ?? Number.POSITIVE_INFINITY;
  const turn = requestState.turn;
  const result = { retrying: false, unansweredAttempts: [], lastAssistant: null, aborted: null };
  const messages = new Set();
  const attempts = new Map();
  for (const event of events) {
    if (event.seq <= from || event.seq > to) continue;
    const data = event.data;
    if (data !== undefined && data !== null && typeof data.turn === 'number' && data.turn !== turn && event.type !== 'agent/inbox/spliced') continue;
    if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
      result.retrying = true;
      continue;
    }
    if (event.type === 'assistant/message') {
      messages.add(`${String(data.turn)}/${String(data.step)}`);
      result.lastAssistant = { seq: event.seq, turn: data.turn, step: data.step, interrupted: data.interrupted === true };
      result.retrying = false;
      continue;
    }
    if (event.type === 'assistant/attempt') {
      attempts.set(`${String(data.turn)}/${String(data.step)}`, event.seq);
      continue;
    }
    if (event.type === 'turn/end') result.retrying = false;
  }
  for (const [turnStep, seq] of attempts) {
    if (!messages.has(turnStep)) result.unansweredAttempts.push({ turnStep, seq });
  }
  if (requestState.reason?.kind === 'aborted') result.aborted = requestState.reason.reason ?? null;
  return result;
}

/** 依赖注入版本；`deps` 让纯逻辑可被内存测试覆盖。 */
export function createRuntime(deps) {
  const { sessions, registry, query, projections, agents, logger } = deps;
  const mkdirImpl = deps.mkdir ?? mkdir;
  const inboxHolds = deps.inboxHolds ?? ((inbox, requestId) => inbox !== undefined
    && [...(inbox['next-turn'] ?? []), ...(inbox['next-step'] ?? [])].some((message) => message?.source?.rpcId === requestId));

  let disposed = false;
  let projectPromise;

  function assertLive() {
    if (disposed) throw httpError(503, 'codex-bridge is disposed');
  }

  function assertSignal(signal) {
    if (signal?.aborted === true) throw httpError(499, 'request was aborted before admission');
  }

  /** 每一步 await 之间都重新检查生命周期：卸载后不再开启新的写入。 */
  async function createProject() {
    assertLive();
    await mkdirImpl(PROJECT_DIR, { recursive: true });                   // 幂等，不覆盖已有内容
    assertLive();
    const workspace = await registry.create(PROJECT_DIR, PROJECT_TITLE); // canonical 复用，不改标题
    assertLive();
    logger.info('codex-bridge: project workspace %s -> %s', workspace.id, workspace.path);
    return workspace;
  }

  /**
   * 单一初始化入口：并发调用复用同一次初始化；
   * 只有「已缓存但注册失效」才清缓存重建；目录不存在也能走到 mkdir。
   */
  function project() {
    if (disposed) return Promise.reject(httpError(503, 'codex-bridge is disposed'));
    if (projectPromise !== undefined) {
      return projectPromise.then((cached) => {
        if (cached !== undefined && registry.get(cached.id) !== undefined) return cached;
        projectPromise = undefined;                                      // 注册被删除 → 走一次新初始化
        return project();
      });
    }
    projectPromise = createProject().catch((error) => {
      projectPromise = undefined;                                        // 初始化失败 → 允许重试
      throw error;
    });
    return projectPromise;
  }

  async function assertSessionInProject(sessionId) {
    const workspace = await project();
    if (!workspace.sessionIds.includes(sessionId)) {
      throw httpError(403, 'session does not belong to the Codex-DeepSeek project');
    }
    return workspace;
  }

  const inFlight = new Map();
  const settled = new Map();

  function rememberSettled(requestId, signature, value) {
    if (settled.size >= SETTLED_LIMIT) {
      const oldest = settled.keys().next();
      if (oldest.done !== true) settled.delete(oldest.value);
    }
    settled.set(requestId, { signature, value });
  }

  /** 同 id 同签名共享同一 Promise；同 id 不同签名 409；已结算按签名复用。 */
  function claimMessage(requestId, signature, run) {
    const done = settled.get(requestId);
    if (done !== undefined) {
      if (done.signature !== signature) throw httpError(409, `requestId "${requestId}" was already completed with different content`);
      return { share: Promise.resolve(done.value), initiator: false };
    }
    const active = inFlight.get(requestId);
    if (active !== undefined) {
      if (active.signature !== signature) throw httpError(409, `requestId "${requestId}" is in flight with different content`);
      return { share: active.promise, initiator: false };
    }
    const promise = Promise.resolve()
      .then(run)
      .then((value) => {
        rememberSettled(requestId, signature, value);
        return value;
      })
      .finally(() => {
        inFlight.delete(requestId);                                      // 结束即释放；未完成项不参与容量淘汰
      });
    inFlight.set(requestId, { signature, promise });
    return { share: promise, initiator: true };
  }

  async function listSessions() {
    assertLive();
    const workspace = await project();
    assertLive();
    return { workspaceId: workspace.id, cwd: workspace.path, sessionIds: [...workspace.sessionIds] };
  }

  async function createSession(body, signal) {
    assertLive();
    assertSignal(signal);
    const { request } = validateCreate(body);
    const workspace = await project();
    assertLive();
    assertSignal(signal);
    // 未提供 sessionId 时由官方生成新 id ⇒ **每次都创建新会话**，不做幂等承诺。
    const created = await sessions.create({ ...request, workspaceId: workspace.id });
    return { sessionId: created.sessionId, agentPreset: created.agentPreset ?? null, idempotent: request.sessionId !== undefined };
  }

  async function sendMessage(body, signal) {
    const parsed = validateMessage(body);
    // 归属校验必须早于任何去重查询：否则跨会话复用同一 requestId 时，
    // 会先被签名冲突挡成 409，永远走不到「不属于本项目」这个更准确的回答。
    await assertSessionInProject(parsed.sessionId);
    const claim = claimMessage(parsed.requestId, parsed.signature, async () => {
      assertLive();
      assertSignal(signal);
      await assertSessionInProject(parsed.sessionId);                    // 投递前再确认一次
      assertLive();
      assertSignal(signal);
      const request = { sessionId: parsed.sessionId, requestId: parsed.requestId, mode: 'queue', content: parsed.content };
      if (parsed.fields.clientTimeZone !== undefined) request.clientTimeZone = parsed.fields.clientTimeZone;
      const accepted = await sessions.prompt(request, signal);
      return { sessionId: parsed.sessionId, requestId: parsed.requestId, accepted: accepted.accepted === true };
    });
    const value = await claim.share;
    return { ...value, deduplicated: claim.initiator === false };
  }

  async function statusOf(url) {
    const sessionId = url.searchParams.get('sessionId');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'sessionId is required');
    const requestId = url.searchParams.get('requestId') ?? undefined;
    await assertSessionInProject(sessionId);

    const observation = await query.readSession(sessionId);
    const events = observation.events;
    const live = agents.get(sessionId);

    const pending = new Map();
    for (const event of events) {
      if (event.type === 'approval/asked') pending.set(event.data.id, { seq: event.seq, toolName: event.data.toolName });
      else if (event.type === 'approval/decided') pending.delete(event.data.id);
    }

    const inbox = live === undefined ? undefined : projections.stateOf(live.session, 'inbox');
    const holds = requestId === undefined || inbox === undefined ? null : inboxHolds(inbox, requestId);

    const folded = foldTurns(events);
    let turnOpen;
    let turnSource;
    if (live !== undefined) {
      const boundary = projections.stateOf(live.session, 'turnBoundary');
      turnOpen = boundary === undefined ? folded.openTurn !== null : boundary.openTurnStartSeq !== null;
      turnSource = boundary === undefined ? 'log' : 'projection';
    } else {
      turnOpen = folded.openTurn !== null;
      turnSource = 'log';
    }

    const requestState = requestId === undefined ? null : requestStateOf(events, requestId, holds);
    const body = {
      sessionId,
      lastSeq: events.length === 0 ? -1 : events.at(-1).seq,
      lastTurn: folded.lastTurn,
      turnOpen,
      turnSource,
      lastTurnEnd: folded.lastEnd,
      awaitingApproval: pending.size > 0,
      pendingApprovals: [...pending].map(([id, row]) => ({ id, ...row })),
      agent: live === undefined ? { live: false } : { live: true, status: live.status },
      pendingInbox: inbox === undefined ? null : {
        nextTurn: (inbox['next-turn'] ?? []).length,
        nextStep: (inbox['next-step'] ?? []).length,
        holdsRequest: holds,
      },
      request: requestState,
    };
    if (requestState !== null) body.requestBehavior = failureOf(events, requestState);
    return body;
  }

  async function eventsOf(url) {
    const sessionId = url.searchParams.get('sessionId');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw httpError(400, 'sessionId is required');
    const rawSince = url.searchParams.get('sinceSeq');
    const sinceSeq = rawSince === null ? -1 : Number(rawSince);
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < -1) throw httpError(400, 'sinceSeq must be an integer >= -1');
    await assertSessionInProject(sessionId);

    const observation = await query.readSession(sessionId);
    const rows = [];
    for (const event of observation.events) {
      if (event.seq <= sinceSeq) continue;
      const view = surfaceEvent(event);
      if (view === null) continue;
      rows.push({ seq: event.seq, type: event.type, time: event.time, ...view });
    }
    return { sessionId, sinceSeq, events: rows, lastSeq: observation.events.length === 0 ? -1 : observation.events.at(-1).seq };
  }

  async function health() {
    const workspace = await project();
    return {
      ready: !disposed,
      route: ROUTE_PREFIX,
      project: { cwd: workspace.path, sessionCount: workspace.sessionIds.length },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBodyBytes: MAX_BODY_BYTES,
      idempotency: 'process-lifetime only; cross-restart idempotency comes from the official requestId/sessionId checks',
    };
  }

  return {
    logger,
    handlers: { health, listSessions, createSession, sendMessage, statusOf, eventsOf },
    markDisposed() { disposed = true; },
    isDisposed() { return disposed; },
  };
}

/** 构造 HTTP 路由；独立导出以便内存测试直接驱动 handler（不启动服务器）。 */
export function buildRoute(runtime) {
  const { logger } = runtime;
  const { handlers } = runtime;
  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req, res) {
      const controller = new AbortController();
      let finished = false;
      let aborted = false;
      let timedOut = false;

      const respond = (status, payload) => {
        if (finished) return;
        finished = true;
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(body.length),
        });
        res.end(body);
      };

      const abort = () => {
        if (aborted) return;
        aborted = true;
        controller.abort(new Error('codex-bridge: request closed'));
      };

      // 这是**整个请求处理**的超时，不是「请求头阶段」。
      // 超时后业务可能已经进入官方不可取消的操作，因此结果未知，只能查询/重试。
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
        respond(504, { ok: false, error: `request exceeded ${String(REQUEST_TIMEOUT_MS)} ms; the outcome is unknown — query /v1/status with the same requestId, or retry with the same requestId` });
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      const onClose = () => {
        if (!finished) abort();                                          // 客户端提前断开
      };
      res.on('close', onClose);

      try {
        if (runtime.isDisposed()) throw httpError(503, 'codex-bridge is disposed');
        if (!isTrustedLocalRequest(req)) {
          respond(403, { ok: false, error: 'loopback-only: Host must be a loopback authority and the request must not be cross-site' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/';
        if (sub === '/v1/health' && req.method === 'GET') respond(200, { ok: true, ...(await handlers.health()) });
        else if (sub === '/v1/sessions' && req.method === 'GET') respond(200, { ok: true, ...(await handlers.listSessions()) });
        else if (sub === '/v1/sessions' && req.method === 'POST') respond(200, { ok: true, ...(await handlers.createSession(await readJsonBody(req, MAX_BODY_BYTES), controller.signal)) });
        else if (sub === '/v1/messages' && req.method === 'POST') respond(200, { ok: true, ...(await handlers.sendMessage(await readJsonBody(req, MAX_BODY_BYTES), controller.signal)) });
        else if (sub === '/v1/status' && req.method === 'GET') respond(200, { ok: true, ...(await handlers.statusOf(url)) });
        else if (sub === '/v1/events' && req.method === 'GET') respond(200, { ok: true, ...(await handlers.eventsOf(url)) });
        else respond(404, { ok: false, error: `no such endpoint: ${req.method ?? 'GET'} ${ROUTE_PREFIX}${sub}` });
      } catch (error) {
        if (timedOut) {
          logger.warn('codex-bridge: request failed after the 504 was sent: %s', errorText(error));
          return;
        }
        const envelope = errorEnvelope(error);
        if (envelope.status >= 500) logger.warn('codex-bridge: %s', errorText(error));
        respond(envelope.status, envelope.body);
      } finally {
        clearTimeout(timer);
        res.off('close', onClose);
        // 只有 413 才需要排空未读完的请求体；此时响应已经写出。
        if (res.statusCode === 413) drainRequest(req);
      }
    },
  };
}

export function apply(ctx) {
  const logger = ctx.logger;
  const sessions = ctx.get('sessionController');
  const registry = ctx.get('workspaceRegistry');
  const query = ctx.get('sessionQuery');
  const webServer = ctx.get('webServer');
  const projections = ctx.get('sessionProjections');
  const agents = ctx.get('agents');
  if (sessions === undefined || registry === undefined || query === undefined || webServer === undefined || projections === undefined || agents === undefined) {
    throw new Error('codex-bridge: missing required services (sessionController / workspaceRegistry / sessionQuery / webServer / sessionProjections / agents)');
  }
  if (webServer.host !== '127.0.0.1') {
    throw new Error(`codex-bridge: refusing to enable an unauthenticated route while the web server binds ${String(webServer.host)}`);
  }

  const runtime = createRuntime({ sessions, registry, query, projections, agents, logger });
  const route = buildRoute(runtime);

  ctx.effect(() => {
    const off = webServer.register(route);
    return () => {
      runtime.markDisposed();
      off();
      logger.info('codex-bridge: route removed from %s', ROUTE_PREFIX);
    };
  }, 'codex-bridge: http route');

  ctx.effect(() => {
    runtime.handlers.health().catch((error) => {
      logger.warn('codex-bridge: project initialization failed: %s', errorText(error));
    });
  }, 'codex-bridge: project initialization');

  logger.info('codex-bridge: route registered at %s (project %s)', ROUTE_PREFIX, PROJECT_DIR);
}