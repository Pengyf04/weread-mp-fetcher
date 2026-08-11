# weread-mp-fetcher

**通过微信读书，把你关注的公众号最新文章抓成一份列表。**

```bash
node bin/weread.mjs --format md
```

```
### 某某公众号

| 时间 | 标题 | 链接 |
|---|---|---|
| 2026-08-04 17:01 | 某某某某某某某某某某 | [原文](https://mp.weixin.qq.com/s/xxxxx) |
| 2026-08-03 18:01 | 另一篇文章的标题 | [原文](https://mp.weixin.qq.com/s/yyyyy) |
```

拿到的是 `mp.weixin.qq.com` **原文直链**，可以直接打开、可以喂给别的工具。

---

## 📋 项目概览

先花一分钟看完这节，判断它是不是你要的东西。

### 它能做什么

- 把你在微信读书里**已订阅公众号**的最新文章列出来（标题、发布时间、`mp.weixin.qq.com` 原文直链）
- 输出 JSON 或 Markdown，可以直接喂给别的工具
- 帮你把新公众号加进来：给一篇它的文章链接就行

### 它不做什么

- ❌ **不替你过验证码**。弹了就停下来提示你手动完成，不识别、不点选、不绕过
- ❌ **不做大规模采集**。内置每日次数硬闸门（默认 2 次/天），适合十几个号以内
- ❌ **不碰你账号看不到的内容**。它只是把你本来就能读的东西用程序读出来
- ❌ **不搜公众号名字**。微信读书网页端搜不到公众号（实测无解），所以用文章链接代替

### 上手路径（详细步骤见下一节）

```
① git clone + cp config.example.json config.json
② 用专用 profile 再开一个 Chrome（--remote-debugging-port=9333 + --user-data-dir，
   日常那个 Chrome 不用关）
③ 在这个新窗口里扫码登录微信读书          ← 全程唯一需要你动手的一步
④ node bin/weread.mjs --add <文章链接>     ← 书架空的才需要
⑤ 填 config.json → node bin/weread.mjs --format md
```

**前置条件**：Node.js 18+（零第三方依赖，不用 `npm install`）、桌面版 Chrome、一个微信号。

### ⚠️ 局限（先知道，别踩坑）

| 局限 | 说明 |
|---|---|
| **收录不全** | 部分公众号在微信读书侧收录滞后，实测遇到过滞后半个多月的。**平台侧问题，技术上无解** |
| **不实时** | 收录通常比公众号发布晚几个小时 |
| **登录要人工** | 扫码没法自动化，登录失效后需要你手动重新扫一次 |
| **规模有限** | 适合十几个以内的号。上百个号需要账号池 + 更严格限频，不在本工具范围 |
| **会遇到验证码** | 需要你手动过，工具会停下来等 |
| **平台随时可能变** | 2026 年 7 月底微信在同一周收紧了多条第三方采集路线，这条同样可能失效。**建议留降级方案** |

### 使用须知

- 本工具只是把**你自己账号本来就能看到的内容**用程序读出来，不解密、不越权、不绕过任何安全机制
- 请遵守微信读书的服务条款，**控制频率**，别拿去做大规模采集或商业分发
- 抓到的文章版权归原作者，转载请遵守对方要求
- **别把它挂成每 5 分钟跑一次的定时任务** —— 真那么干，坏的是你自己的账号
- 用了出问题自己负责

---

## 为什么是「通过微信读书」

> 只想用的话可以跳过这节，直接看「快速开始」。

公众号文章一直不好批量拿。2026 年 7 月底微信关掉了公众平台后台的跨账号查询接口，一批依赖它的开源项目同时失效，其中一个 12k+ star 的项目直接归档了。

微信读书是另一条路：**它把公众号当成「书」**，`bookId` 形如 `MP_WXS_<一串数字>`，文章通过网页版接口取，返回里带着原文 id，拼起来就是原文直链。这条路和上面那个被关掉的接口是两套系统，没受影响。

**做法就是**：在你自己那个已经登录微信读书的 Chrome 里，执行一小段 JS 去调它自己的接口。不用 Docker、不用服务器、不用申请公众号、不用装手机 App、不用第三方 API。

---

## 快速开始

> 前置条件见上方「项目概览」。

### 第 1 步：装上

```bash
git clone https://github.com/Pengyf04/weread-mp-fetcher.git
cd weread-mp-fetcher
cp config.example.json config.json
```

### 第 2 步：让 Chrome 开着调试端口

工具需要在**一个已登录微信读书的 Chrome** 里执行 JS，所以要用调试端口启动它。

有两条路。**推荐方案 A**，方案 B 只在你确实不想再开一个 Chrome 实例时才用。

> 本节结论基于 **Chrome 151（2026-08）实测**。Chrome 每 4 周一个大版本，行为可能变。

#### 方案 A（默认推荐）：专用调试 Profile

**macOS**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.weread-mp-fetcher/chrome-profile"
```

**Windows**（PowerShell）

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9333 `
  --user-data-dir="$env:USERPROFILE\.weread-mp-fetcher\chrome-profile"
```

**Linux**

```bash
google-chrome \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.weread-mp-fetcher/chrome-profile"
```

对应的 `config.json`：

```json
{ "chromePort": 9333, "chromeProfileDir": "~/.weread-mp-fetcher/chrome-profile" }
```

几件要知道的事：

- 这是**第二个独立的 Chrome 实例**，和你日常那个**同时开着互不影响**（因为 `--user-data-dir` 不同）。**不需要退出你日常的 Chrome。**
- 这个新窗口第一次确实是没登录的，**扫一次码就好**——登录态存在这个专用目录里，Chrome 完全退出再启动仍然保持登录（实测）。
- **端口用 9333 不是 9222。** 9222 是各类调试工具的事实默认端口，极易被占；而且**端口冲突不会报错**——实测 9222 被占时，第二个实例会静默退到 IPv6 `[::1]:9222`，此时 `curl http://127.0.0.1:9222/json/version` 打到的是**另一个**实例、返回 404，极具迷惑性。
- ⚠️ 同一个 `--user-data-dir` **同时只能有一个 Chrome 进程**。目录已被占用时再带参数启动，只会打印「正在现有的浏览器会话中打开」并给旧进程开个新窗口，**你新加的所有参数被静默忽略**。所以「改了参数没生效」时，先确认这个专用实例是不是已经在跑。
- ⚠️ **Chrome 136（2025-04）起，在默认用户数据目录上 `--remote-debugging-port` 会被静默忽略**（[官方说明](https://developer.chrome.com/blog/remote-debugging-port)），端口根本不会开，而且**没有任何报错**。所以 `--user-data-dir` 不是可选项。

> 调试端口只监听 `127.0.0.1`，外部访问不到。但开着它意味着本机程序都能控制这个 Chrome，介意的话用完把这个专用实例关掉即可（不影响你日常那个）。

#### 方案 B（备选，不推荐做日常）：用你正在用的那个 Chrome

Chrome ≥ 144 提供了一个开关，可以在**默认 profile** 上开调试：`chrome://inspect/#remote-debugging` → 打开 **"Allow remote debugging for this browser instance"**（[官方说明](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)）。

选它之前必须知道（实测）：

- **工具每建立一次新连接，你都要切到 Chrome 手动点一次「允许」。** 点了约 2.6 秒握手成功；不点就一直挂着（实测 60 秒 / 90 秒），而且**授权不跨连接复用**。→ **不能自动化、不能定时跑、不能无人值守。**
- 这个模式下 `http://127.0.0.1:<端口>/json/version` 返回 **404**，工具改从**默认 profile 目录**下的 `DevToolsActivePort` 文件里读端口和 WebSocket 路径。
- 对应的 `config.json` 是**两项都留空**（照抄方案 A 的配置会两处都指错）：

  ```json
  { "chromePort": null, "chromeProfileDir": null }
  ```

「每次都要点允许」是 Chrome 的设计，本工具不会也不应该绕过它。

### 第 3 步：登录微信读书

在**第 2 步启动的那个 Chrome** 里打开 <https://weread.qq.com/>，**微信扫码登录**。

**就这一步需要你动手，剩下的工具全自动。**（方案 A 第一次是空白 profile，扫一次码之后长期有效。）

### 第 4 步：把想看的公众号加进来

**如果你在微信读书里已经订阅过公众号**，直接看看有哪些：

```bash
node bin/weread.mjs --shelf
```

**如果一个都没有**（新账号常见），随便打开该公众号的**任意一篇文章**，复制链接，然后：

```bash
node bin/weread.mjs --add https://mp.weixin.qq.com/s/xxxxxxxx
```

工具会自己算出这个号的 `bookId` 并订阅：

```
解析成功:MP_WXS_0000000000 (某某公众号)  ← 文章页里的 __biz
已加入书架:MP_WXS_0000000000
```

> **为什么要给文章链接而不是名字？** 微信读书的网页端**搜不到公众号**（实测 6 种接口/参数组合全部无效）。但公众号的身份标识 `__biz` 就明写在它每一篇文章的页面里，`bookId = MP_WXS_ + base64解码(__biz)`——所以给一篇文章比给名字更可靠。文章链接在微信里长按「复制链接」就有。
>
> `--add` 也接受多个，以及直接给 `bookId`：
> `node bin/weread.mjs --add <链接1> <链接2> MP_WXS_0000000000`

### 第 5 步：配置并运行

把 `--shelf` 输出里想监控的号，粘进 `config.json` 的 `accounts`：

```json
"accounts": [
  { "name": "某某公众号", "bookId": "MP_WXS_0000000000" }
]
```

然后：

```bash
node bin/weread.mjs --format md
```

完成。

> **不用手动复制阅读器页 URL。** 工具会从书架接口自动推导出来。（早期版本要求手动复制，现在不需要了。）

## 命令

| 命令 | 作用 |
|---|---|
| `node bin/weread.mjs` | 抓取，输出 JSON |
| `node bin/weread.mjs --format md` | 抓取，输出 Markdown 表格 |
| `node bin/weread.mjs --probe` | **只看页面状态，不抓取**。免费，不消耗每日次数 |
| `node bin/weread.mjs --shelf` | 列出你已订阅的公众号、`bookId` 和阅读器页 URL |
| `node bin/weread.mjs --add <链接\|bookId>...` | 订阅公众号。给文章链接会自动算出 `bookId` |
| `node bin/weread.mjs --quota` | 看今天已经抓了几次 |
| `--config other.json` | 用别的配置文件 |

---

## ⚠️ 关于限频：请务必看一眼

微信读书对这个接口**有风控**。作者在验证方案那天，一天里请求了 30 多次，直接触发反爬——页面白屏了好几个小时。

所以工具内置了每日次数上限，默认 **2 次/天**：

```json
"maxRunsPerDay": 2,
"requestIntervalMs": 3000
```

- 达到上限会直接拒绝执行，不是警告
- 每个公众号之间默认间隔 3 秒，**别调到 1 秒以下**
- `--probe` 不算次数，随便跑
- 抓取失败不计数，但**也别立刻重试**，隔几小时再说

社区经验是：几个号、每天几次，没问题；上百个号必须账号池加严格限频，那不在本工具范围内。

---

## 遇到验证码怎么办

页面可能会弹出腾讯防水墙的验证码（图片选择或滑块）。这时候：

```
$ node bin/weread.mjs
页面弹出了验证码,需要你在 Chrome 里手动完成。
   完成后重新运行本命令即可。
```

**切到 Chrome 里手动过一下，然后重新运行命令就行。** 工具会自动确认页面恢复正常之后才继续抓取。

> 本工具**不会**替你识别、点选或绕过验证码——那是绕过人机校验，不做。它做的是「发现验证码 → 停下来 → 告诉你 → 等你处理完 → 自己确认真的好了 → 继续」。

想少碰到验证码，最有效的办法是：**让那个阅读器标签页一直开着**。反复新开标签页是触发风控的主要原因。

---

## 常见问题

**接口返回 `-2041`**
不是限流也不是封号，是**上下文校验**：请求必须发在阅读器页（`/web/mp/reader/...`）里，在微信读书首页发同样的请求一定失败。工具已经处理了（自动导航到阅读器页再发请求），正常不会遇到。

**接口返回 `-2010 用户不存在`**
登录失效了，在 Chrome 里重新扫码登录微信读书即可。

**页面白屏、`--probe` 报 `blank`**
触发风控了。停手，隔几个小时再试，并且改掉反复新开标签页的习惯。

**某个公众号一直取不到新文章**
先确认不是工具的问题：在浏览器里手动打开那个公众号看看。**微信读书对部分公众号的收录会滞后**，实测遇到过滞后半个多月的。这是平台侧的事，技术上解决不了。

**一天明明发了好几篇，只取到一篇**
如果你是照着思路自己实现的，检查有没有只读了 `subReviews[0]`。微信读书的结构是「一次群发 = 一个条目，里面的 `subReviews` 才是一篇篇文章」，有的号一天群发 3–4 篇。本工具已经展开了。

**能不能直接给公众号名字，让它自动搜出来？**
不能。微信读书网页端搜不到公众号（实测 `/web/search/global` 加 `type`/`scope` 等参数返回的都是书；MP 专用端点全 404）。用 `--add <文章链接>` 代替，效果一样且更可靠。

**找不到 Chrome 调试端口**
先跑一条 curl，按结果对号入座（把 9333 换成你实际用的端口）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9333/json/version
```

| 结果 | 含义 | 怎么办 |
|---|---|---|
| `200` | 方案 A 正常 | 直接跑工具 |
| `404` | 你连到的是一个方案 B（auto-connect）实例，不是方案 A 的专用实例 | 换个端口重开专用实例，或确认启动命令真的生效了 |
| `000` / 拒绝连接 | 端口没开 | 两个常见原因：① 参数加在了**默认用户数据目录**上（Chrome 136+ 会静默忽略）；② 那个专用目录**已经有一个 Chrome 进程在跑**，新参数被静默忽略 |
| 工具挂起几十秒没输出 | 多半是方案 B 在等你点「允许」 | 切到 Chrome 点一下，或改用方案 A |

也可以在 `config.json` 里显式写 `"chromePort": 9333`。

---

## 输出格式

```json
{
  "onReader": true,
  "sources": [
    {
      "name": "某某公众号",
      "bookId": "MP_WXS_0000000000",
      "items": [
        {
          "t": 1785636055,
          "title": "文章标题",
          "url": "https://mp.weixin.qq.com/s/xxxxx",
          "rid": "MP_WXS_xxx_yyy"
        }
      ]
    }
  ]
}
```

- `t` 是 Unix 秒。做增量的话，记住每个号上次的最大 `t`，下次只取更大的
- ⚠️ 同一次群发的多篇文章 `t` **完全相同**，用 `>` 比较会把它们重复取出来。按 `url`/`rid` 去重更稳
- 单个号一次能取约 20 次群发，展开后通常 70–80 篇

---

## 项目结构

```
bin/weread.mjs        命令行入口
lib/cdp.mjs           零依赖的 Chrome 控制客户端(自己实现了 WebSocket)
lib/scripts.mjs       注入页面执行的 JS:状态探针 / 抓取 / 书架 / 订阅
lib/mp.mjs            从公众号文章链接推导 bookId(解析 __biz)
lib/quota.mjs         每日次数闸门
test/offline.test.mjs 离线自测,不连 Chrome 也能跑
config.example.json   配置模板
docs/HOW-IT-WORKS.md  原理、踩过的坑、判据是怎么定出来的
```

没有 `npm install`，没有 `node_modules`，没有编译步骤。

---

## License

MIT
