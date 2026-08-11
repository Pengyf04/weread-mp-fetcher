// 零依赖 Chrome DevTools Protocol 客户端。
//
// 只做两件事:列出标签页、在指定标签页里执行 JS。
// 不用 puppeteer/playwright/ws —— 那些要么体积大,要么会被风控识别成自动化浏览器。
// 这里连的是**你自己那个已经登录好的 Chrome**,不新开浏览器实例。
//
// Node 18+ 可用(自己实现了 WebSocket 帧,不依赖 Node 22 的全局 WebSocket)。

import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- 找到 Chrome 的调试端口 ----------

// Chrome 会把实际端口写进用户数据目录下的 DevToolsActivePort:
//   第 1 行 = 端口号
//   第 2 行 = 浏览器级 WebSocket 路径
// 用它的好处:即使你启动时写的是 --remote-debugging-port=0(随机端口)也能找到。
const DEFAULT_PROFILE_DIRS = {
  darwin: ['Library/Application Support/Google/Chrome'],
  linux: ['.config/google-chrome', '.config/chromium'],
  win32: ['AppData/Local/Google/Chrome/User Data'],
};

export function readDevToolsActivePort(profileDir) {
  const candidates = profileDir
    ? [profileDir]
    : (DEFAULT_PROFILE_DIRS[process.platform] || []).map((p) => path.join(os.homedir(), p));

  for (const dir of candidates) {
    const file = path.join(dir, 'DevToolsActivePort');
    try {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').split('\n');
      if (port && /^\d+$/.test(port.trim())) {
        return { port: Number(port.trim()), browserWsPath: (wsPath || '').trim() };
      }
    } catch {
      /* 换下一个候选目录 */
    }
  }
  return null;
}

// ---------- 连接失败时的指引文案 ----------
//
// ⚠️ 这段必须与 README「让 Chrome 开着调试端口」一节**说同一件事**:用户照着报错做,
//    和照着 README 做,不能得到两种结果。旧文案写的是"请用 --remote-debugging-port=9222
//    启动 Chrome",三处都不对 —— 端口示例与 README 的 9333 冲突;漏了 --user-data-dir,
//    而 Chrome 136(2025-04)起在默认用户数据目录上单给端口参数会被**静默忽略**(端口不开、
//    也不报错),照着做必然卡住;而且完全没提方案 B。
// ⚠️ 离线测试「Chrome 连接报错文案」会从 README 里取关键 token 逐个比对 ——
//    改了一边不改另一边会当场失败。

export const CONNECT_HELP =
  '两种启动方式(与 README「让 Chrome 开着调试端口」一节一致):\n' +
  '\n' +
  '  方案A(默认推荐,专用调试 profile)—— 下面两个参数缺一不可:\n' +
  '    --remote-debugging-port=9333 --user-data-dir="$HOME/.weread-mp-fetcher/chrome-profile"\n' +
  '    ⚠️ Chrome 136 起,只给 --remote-debugging-port、不给 --user-data-dir(即用默认用户数据目录),\n' +
  '       端口参数会被静默忽略:端口根本不会开,而且没有任何报错。\n' +
  '    对应配置:{"chromePort": 9333, "chromeProfileDir": "~/.weread-mp-fetcher/chrome-profile"}\n' +
  '\n' +
  '  方案B(备选,用你日常那个 Chrome)—— 打开 chrome://inspect/#remote-debugging 里的\n' +
  '    "Allow remote debugging for this browser instance"(Chrome ≥ 144)。\n' +
  '    ⚠️ 每建立一次新连接都要切到 Chrome 手动点一次「允许」,不能无人值守。\n' +
  '    对应配置:{"chromePort": null, "chromeProfileDir": null}';

// ---------- 极简 WebSocket 客户端 ----------
//
// 为什么自己写:CDP 的 Runtime.evaluate 只能走 WebSocket,没有纯 HTTP 的替代。
// 而 Node 20 及更早没有全局 WebSocket,引入 ws 包又违背零依赖的初衷。
// 客户端→服务端的帧必须掩码,服务端→客户端不掩码 —— 这是 RFC 6455 的规定。

class MiniWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handlers = [];
    this.fragments = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
  }

  static connect(host, port, wsPath, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(port, host);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 Chrome 超时(${host}:${port})`));
      }, timeoutMs);

      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });

      socket.once('connect', () => {
        socket.write(
          `GET ${wsPath} HTTP/1.1\r\n` +
            `Host: localhost:${port}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });

      let headerBuf = Buffer.alloc(0);
      const onHandshake = (chunk) => {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const header = headerBuf.slice(0, end).toString();
        socket.removeListener('data', onHandshake);
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101/.test(header)) {
          socket.destroy();
          reject(new Error(`Chrome 拒绝 WebSocket 升级:\n${header.split('\r\n')[0]}`));
          return;
        }
        const ws = new MiniWebSocket(socket);
        const rest = headerBuf.slice(end + 4);
        if (rest.length) {
          ws.buffer = rest;
          ws.#drain();
        }
        resolve(ws);
      };
      socket.on('data', onHandshake);
    });
  }

  onMessage(fn) {
    this.handlers.push(fn);
  }

  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    try {
      this.socket.end();
    } catch {
      /* 已经断了就算了 */
    }
  }

  #drain() {
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) return;
      const { opcode, fin, payload } = frame;

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) continue; // ping,CDP 场景不需要回 pong
      if (opcode === 0xa) continue; // pong

      // 大的 CDP 响应会被拆成多帧,要拼起来
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.fragments.push(payload);
        if (!fin) continue;
        const full = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        for (const fn of this.handlers) fn(full);
      }
    }
  }

  #readFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      len = Number(b.readBigUInt64BE(offset));
      offset += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.slice(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;

    let payload = b.slice(offset, offset + len);
    if (mask) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    this.buffer = b.slice(offset + len);
    return { fin, opcode, payload };
  }
}

// ---------- CDP 会话 ----------

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onMessage((text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 60000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    this.ws.close();
  }
}

/**
 * 连接到本机已在运行的 Chrome。
 * @param {{port?:number, profileDir?:string, host?:string}} opts
 */
export async function connectChrome(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const found = readDevToolsActivePort(opts.profileDir);
  const port = opts.port || found?.port;
  if (!port) {
    throw new Error(
      '找不到 Chrome 的调试端口(配置里没写 chromePort,也没在 profile 目录里读到 DevToolsActivePort)。\n\n' +
        CONNECT_HELP
    );
  }

  // 优先用浏览器级 WebSocket:部分 Chrome 版本/配置下 /json 这类 HTTP 端点会返 404,
  // 但 WebSocket 一直可用。拿不到路径时再退回 HTTP 探测。
  //
  // ⚠️ 文件里的 wsPath 属于**写这个文件的那个实例**。如果你显式指定了端口,而文件里记的是
  //    另一个端口,那这两样东西来自不同的浏览器实例 —— 拿 A 实例的 wsPath 去连 B 端口
  //    是连不上的。此时以**显式端口**为准,丢弃文件里的 wsPath,改走 HTTP 探测。
  //    (典型场景:日常 Chrome 开着 auto-connect,在默认 profile 目录留了一份 9222 的
  //     DevToolsActivePort;而你的 config 里写的是专用实例的 9333。)
  let browserWsPath = found && found.port === port ? found.browserWsPath : undefined;
  if (!browserWsPath) {
    const res = await fetch(`http://${host}:${port}/json/version`).catch(() => null);
    if (res && res.ok) {
      const info = await res.json();
      browserWsPath = new URL(info.webSocketDebuggerUrl).pathname;
    }
  }
  if (!browserWsPath) {
    throw new Error(
      `${host}:${port} 上拿不到浏览器 WebSocket 路径(/json/version 没返回 200)。\n` +
        '方案A 下这里应该是 200;返回 404 通常说明这个端口后面不是方案A 的专用实例\n' +
        '(可能是一个 auto-connect 实例,或端口冲突时静默退到 IPv6 的另一个实例)。\n\n' +
        CONNECT_HELP
    );
  }

  const ws = await MiniWebSocket.connect(host, port, browserWsPath);
  return new CdpSession(ws);
}

/** 列出所有普通网页标签页 */
export async function listTabs(session) {
  const { targetInfos } = await session.send('Target.getTargets');
  return targetInfos
    .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    .map((t) => ({ targetId: t.targetId, title: t.title, url: t.url }));
}

/**
 * 新开一个标签页,并**等它真的导航过去**。
 * ⚠️ 短时间内反复开同一个 URL 容易触发风控,能复用就别开。
 *
 * Target.createTarget 会立刻返回,那一刻页面还停在 about:blank。
 * 不等就去执行 JS,拿到的是空白页 —— 每个第一次使用的人都会踩这个。
 */
export async function createTab(session, url, timeoutMs = 20000) {
  const { targetId } = await session.send('Target.createTarget', { url, background: true });
  const deadline = Date.now() + timeoutMs;
  const wantHost = (() => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  })();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const { targetInfos } = await session.send('Target.getTargets');
    const me = targetInfos.find((t) => t.targetId === targetId);
    if (!me) break;
    if (!(me.url && me.url !== 'about:blank' && (!wantHost || me.url.includes(wantHost)))) continue;

    // ⚠️ targetInfo.url 变了**不代表页内 JS 上下文已经就绪**。实测:此时页面里的
    //    location 仍可能停在 about:blank,于是页内的相对 fetch('/web/...') 直接报
    //    "Failed to parse URL"。没有已开 weread 标签页的新用户首跑必经这条路。
    //    所以再往页里问一次「你现在是谁、加载到哪一步了」。
    let href = '';
    let ready = '';
    try {
      const s = await evaluate(session, targetId, 'location.href + "|" + document.readyState', 5000);
      [href = '', ready = ''] = String(s ?? '').split('|');
    } catch {
      continue; // 执行上下文还没建好,evaluate 会失败 —— 再等一轮
    }
    if (wantHost && !href.includes(wantHost)) continue;
    if (ready === 'loading') continue;
    return targetId;
  }
  return targetId; // 超时也把 id 还回去,让上层的探针给出更具体的判断
}

/**
 * 重新加载指定标签页。
 *
 * ⚠️ 这是本仓库唯一用到 Page 域的地方(其余只用 Target.* 与 Runtime.evaluate)。
 * ⚠️ Page.reload 的响应是"命令已受理",**不等导航完成**。所以绝不能假设它返回时
 *    页面就绪 —— 调用方必须随后用 probeUntilReady 轮询兜住。而且探针读的是取样那一刻的
 *    DOM 快照、可能过期,刷新途中取样可能读到旧页面,所以要轮询、不能只探一次。
 */
export async function reloadTab(session, targetId, timeoutMs = 30000) {
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    // Page.enable 是否必需未实测;失败不阻断,让 Page.reload 自己去报错,
    // 这样出问题时能分清是哪一步的问题。
    await session.send('Page.enable', {}, sessionId, timeoutMs).catch(() => {});
    await session.send('Page.reload', { ignoreCache: false }, sessionId, timeoutMs);
  } finally {
    await session.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

/**
 * 在指定标签页里执行一段 JS,返回它的值。
 * 表达式若返回 Promise 会自动等待 —— 抓取脚本正是靠这个。
 */
export async function evaluate(session, targetId, expression, timeoutMs = 90000) {
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const res = await session.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`页面里执行出错: ${d.exception?.description || d.text}`);
    }
    return res.result?.value;
  } finally {
    await session.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}
