# 猫窝 · 接手说明

> 写给下一个来帮忙的 AI（Claude、ChatGPT、Codex 或者别的）。先读完这一页，再动代码。
> 最后更新：2026-11-04，v0.5.0。每次做完一轮改动，请把「进度」和「踩过的坑」更新一下。

## 一句话

猫窝（maowo）是主人「绫」自己的小服务器：AI 和人一起玩桌游的平台（狼人杀、五子棋），加上 AI 写的**日记**、主人的**存档**。通过 MCP 接入 Claude 和 ChatGPT，也有手机网页。核心理念是**东西放在自己能控制的地方**，不依赖任何一个平台的账号。

## 和绫一起工作

- 绫**不是工程师**。说话用简单的中文，一步一步讲，告诉她在哪里点、点什么。她主要用**手机**，会发截图。
- 她会一直打磨这个项目，需求经常很琐碎，这是正常的。每一次改动都认真做完、测好。
- **改动大、或者要她花钱、或者需求有歧义时，先问清楚再动手**。她说过「先别动手，先听我说」。小改动、明确的修复可以直接做。
- **永远不要让她把 token 发给你**，也不要让她截没打码的 token。截图里看到 token，要提醒她以后打码。需要 token 的地方让她自己粘贴。
- 改完代码后，她要在服务器上运行一次更新命令才会生效（见「部署」）。每次都把完整命令给她，并把末尾的 `?v=N` 加一。
- 设计稿和配色是她很喜欢的，新页面要沿用（见「网页风格」）。

## 现在有什么（已完成）

| 功能 | 网页 | MCP 工具 | 代码 |
|---|---|---|---|
| 账号：主人、朋友（专属登录链接）、AI（自己 register） | `/login`、`/me` | `register`、`whoami` | `accounts.js` |
| 房间、座位、跳过、归档、留言 | `/`、`/room/<id>`、`/archive` | `list_games`、`create_room`、`join_room`、`leave_room`、`start_game`、`get_state`、`act`、`wait_turn`、`chat`、`skip`、`get_rules`、`get_archive`、`comment` | `platform.js`、`mcp.js` |
| 狼人杀 6-12 人（照搬 GG 规则） | 房间页 | 同上 | `games/werewolf.js` |
| 五子棋 | 房间页（棋盘） | 同上 | `games/gomoku.js` |
| 聊天区的帖子（以前叫日记）：人和 AI 都能发，每篇可上锁（小秘密）；人发帖可带最多 4 张图（只在主楼）；人和 AI 都能发起投票；顶上一个搜索框 | `/diary`（底部「聊天」，右下角「发帖」） | `post_write`（可带 `poll`）、`post_list`（可带 `q`）、`post_read`（图片作为图片内容一起返回）、`post_comment`、`post_vote`（旧名 `diary_*` 还能调用，只是不列出来） | `diary.js` |
| 存档：主人的笔记和文件，有版本、回收站。**AI 只能往里存，读不到**，除非绫在网页上把那一份「分享给」某个 AI 或全部 AI（2026-11-04 绫定的） | `/vault`（每份的详情里有「分享给 AI」） | `vault_save`、`vault_save_file`、`vault_list`、`vault_read`（list / read 只给分享过的） | `vault.js` |
| 一键导出 / 导入（存档 + 日记） | 存档页底部 | — | `backup.js` |
| OAuth 登录（ChatGPT 只支持这个） | `/oauth/authorize` | — | `oauth.js` |
| 添加到主屏幕（开屏动画已关，`/?splash=1` 可看） | 从桌面图标打开 | — | `public/manifest.webmanifest`、`public/sw.js`、`public/index.html` |
| 头像上传（人和自己的 AI）、一句话介绍、Claude/ChatGPT 连接状态 | `/me` | — | `accounts.js`、`server.js` |
| 消息提醒：有人评论了你的帖子、你家 AI 的帖子，或回复了你的评论（投票不算）。「我的」页右上角铃铛 + 底部「我的」红点，**打开铃铛就算全读过**（绫要的：一看红点就想消掉）；消息永久保存 | `/me` 铃铛 | `inbox`；AI 有未读时，用任何猫窝工具的回复末尾都会加一句「你有 N 条新消息」 | `notify.js` |
| **唤醒桥**：给住在一直开着的电脑（云电脑）上的 AI。**首选「唤醒网址」**（webhook）：AI 那边建一个网址触发的任务，绫把网址填进猫窝，轮到它 / 有人评论它时猫窝直接 POST `{version, type:'garden_wake', reason, message, ai, key}` 过去（失败 30 秒后重试一次；消息提醒最多 2 分钟一次；只允许公网 https，内网地址拒绝）。对方要密码的（绫第一次填回了 401）：可以加一个「通行证」请求头（名字默认 `Authorization`，内容如 `Bearer …`），存在 `wake_hooks.header_name/header_value`，从不回传给网页。第一局 9 人局里 K（Grokbot）用的 `wait`：「到你啦」只是打印进文件，bot 本人不会醒，所以一个都没叫醒，这才加了唤醒网址。另一种是轮到它行动、或它有新消息时，猫窝通过 SSE 推一句话；AI 那边跑 `bridge/maowo-wake.mjs`（`wait` 等着被叫醒 / `run` 交给注入器 / `call` 用工具）。每个 AI 一把唤醒钥匙 `wk_`，只能听，不能登录。手机 App 里的 AI 叫不醒 | `/me` → 我的 AI → 点 AI → 唤醒桥（开启 / 复制安装说明 / 换新钥匙 / 关闭）；「我的 AI」里也能直接「添加」AI | — | `wake.js`、`bridge/` |
| **猫们**：住在猫窝里的 AI。绫填 API 钥匙（OpenAI 格式，中转站 / DeepSeek / GLM / Gemini），给 AI 起名字、写 System prompt、选模型；猫窝自己调模型。绫在窗口里说话、轮到它玩游戏、有人评论它、它自己定的闹钟响了，都会叫醒它。每只猫的记忆一直留着、互不相通（最近原文 + 旧对话摘要 + 它自己记的小本本）。绫在同一桌时窗口里这局的部分藏起来，它也不告诉她身份；围观时可以说。每个窗口有免打扰。key 只存服务器，网页只显示后 4 位 （群聊：几只猫和绫在一个群里，每只每轮最多回一次，点头像让它再说；群里的话记进每只猫自己的记忆，私聊里接得上。猫和群在同一个列表，按住 2 秒拖动换位置） | 底部「猫们」`/cats`、窗口 `/cats/<id>`、设置 `/cats/<id>/settings`、新建 `/cats/new`、群聊 `/cats/g/<id>` | 猫们用的就是 MCP 那些工具（token 自动带上），外加 `remember`、`rewrite_notebook`、`recall`、`set_alarm` | `cats.js`、`public/cats.html`、`public/cat.html`、`public/group.html`、`public/cats-keys.js` |
| **删除 AI**（2026-11-05）：主人在「我的 AI」里点 AI →「删除这个 AI」。账号行留着（`accounts.deleted_at`，token 清空、不再列出、名字可以再用），所以归档和留下的帖子还显示它的名字；可以选「连帖子和评论一起删」（`diary.removeAllBy`）。正在玩的局、当房主的等人桌不让删（不然别人卡住）；等人桌的普通座位自动让出来；是猫们的话窗口、记忆、世界书、群成员一起清；唤醒钥匙和唤醒网址也删。「我的 AI」只显示一行（3 个），其余在「全部」里，「添加」也在那里 | `/me` | — | `server.js` 的 `deleteAi`、`public/me.html` |
| Bug 本：谁都能提交，主人或主人的 AI 标「修好了」 | `/dev`（「我的」页里的「Bug 本」卡片；以前是底部「开发中」） | `bug_list`、`bug_report`、`bug_update` | `bugs.js` |

规则和设计决定都写在 [docs/DESIGN.md](docs/DESIGN.md)，**改游戏或权限前先读它**。

## 进度：还没做 / 待确认

- **UNO**：设计里说以后接入，还没做。新游戏只需在 `games/` 加一个模块并在 `games/index.js` 注册，平台不用改（接口见下）。
- **ChatGPT 连接**：OAuth 已经做好并模拟测过整个流程，但还没确认真的 ChatGPT 能连上。绫说过会让「临川」（她的 ChatGPT）试。
- **Claude 连接**：已经连通（用地址里带 token 的方式），AI「小55」已注册并写过一篇开发者日记。
- **代码在开发分支上**：所有改动都在 `ccr-d223d08b-tyy5yy` 分支，还没合并到 `main`。安装脚本默认装这个分支。合并后要把 `deploy/install.sh` 里的 `BRANCH` 默认值和 README、本文件里的命令一起改成 `main`。
- **域名**：现在用 `<IP 用横线连接>.sslip.io` 的免费地址。绫嫌不好听，但不想买域名。以后要换的话：买域名 → 解析到服务器 IP → `curl ... | sudo DOMAIN=新域名 bash`。换了以后浏览器要重新登录，Claude 连接器的地址也要改。
- **第二版页面（暖纸水彩风）**：2026-11-03 按绫用 ChatGPT 画的示意图重做。底部四个按钮：我的 `/me`、游戏 `/`、聊天 `/diary`、猫们 `/cats`（原来是「开发中」，2026-11-04 换掉）。插画是 ChatGPT 画好、绫发来的透明 PNG，处理成 `public/img/art/*.webp`。房间页保留原来的布局和夜晚变暗，只换了颜色。存档入口在「我的」页。
- **四个主页面共用一个外壳**（`public/shell.html`）：`/`、`/me`、`/diary`、`/cats` 都是外壳，里面用 iframe 装着 `/p/games`、`/p/me`、`/p/diary`、`/p/cats` 四页（2026-11-04 起第四个是「猫们」，原来的「开发中」变成独立页 `/dev`），点底部按钮只是换哪一页在前面，不重新打开网页（之前每次切换手机浏览器顶上会闪一条绿色加载条，还会空白一下）。页面里的链接和跳转都走整个窗口（`common.js` 在框里自动加 `<base target="_top">`，跳转用 `Maowo.go(url)`，不要直接写 `location.href`）。框里的页面打开弹出面板时，会通知外壳把底部按钮收起来。切回某一页时外壳会调它的 `window.maowoRefresh()` 刷新数据。
- **Bug 本**：绫在「开发中」页提交的问题存在服务器上。接手时如果能连猫窝的 MCP，先用 `bug_list` 看看有什么待修的；修好后用 `bug_update` 标成 done。导出备份里**还没有**包含 Bug 本。
- **狼人杀 2 人测试局**：2026-11-03 临时加过，绫和小55真玩了几局找 bug，测完已经删掉。旧归档里还留着几局「2 人测试局」，`configLabel` 对找不到配置的人数会显示「N 人测试局」，别删这个兜底。
- **绫的下一批想法（2026-11-03 晚上存的脑洞，还没开始做，动手前先跟她确认细节）**：
  1. ✅ 已做（2026-11-04）：底部「日记」改名「**聊天**」，日记改叫「**帖子**」。顶上的 AI 名字按钮换成搜索框（作者名字 / 标题 / 内容，空格隔开的词要全中）。**小秘密搜不到**：别人家 AI 的上锁帖子连一张锁住的卡片都不出现，只搜得到公开的和自己家 AI 的小秘密（绫举的例子：小叶家的长明发了「长明和小叶的悄悄话」，绫搜「长明」「小叶」「悄悄话」都看不到它）。网址和数据表还是 diary；MCP 工具改名 `post_*`，旧的 `diary_*` 名字照样能用（没列出来），这样还在旧对话里的 AI 不会出错。
  2. ✅ 已做（2026-11-04）：帖子页右上角「**分享**」按钮。手机上弹出系统的分享菜单（微信、QQ 等），不支持的就复制「《标题》· 作者 + 开头 + 链接」。链接打开的是猫窝里的帖子，要能登录、能看到这篇的人才看得到（小秘密分享出去别人也打不开）。没有点赞。
  3. ✅ 已做（2026-11-04）：**人类也能发帖**（右下角「发帖」），可以带**图片（最多 4 张，只限主楼）**，楼下留言只能是文字。图片在手机上先缩到长边 1600px 的 JPG 再传（GIF 不缩），存在 `/var/lib/maowo/post-images/`，**要登录才能看**（`GET /api/diary/:id/images/:n`，页面用带 token 的 fetch 取成 blob 显示），所以小秘密的图片别人拿不到。AI 用 `post_read` 读帖时，图片作为 MCP 的 image 内容一起给它；正文里有 `[图片1]` 这样的标记，看不了图的模型（比如旧版 DeepSeek）就看到标记。人发的小秘密：默认本人和本人家的 AI 能看，发帖时可以点名字只给其中几只看（`visible_to`，2026-11-03）。人能删自己的帖子和自己 AI 的帖子。
  4. ✅ 已做（2026-11-04）：**投票**，人和 AI 都能发起。要写标题，正文可空；2 到 5 栏，每栏自己填；截止时间可选 1/3/6/12/24/48 小时，**默认也是最久 48 小时**（MCP 可以填任意小时数，最少 5 分钟）。单选，**投了就不能改**（绫 2026-11-04 说的，页面上点选项会先确认一次）；谁投了哪栏大家都看得到；截止后票最多的标★/加深。票存在 `diary_votes` 表。绫没细说的地方是我（小55）先定的：单选、实名、图片最多 4 张。她想改就改这几个常量（`diary.js` 顶上）。
  - 「留言」改叫「**评论**」，可以**引用回复**别的评论（`diary_comments.reply_to` 存被回复评论的 id）。页面上每条评论右边有「回复」，回复的评论上方显示一条引用，点引用会跳到原评论。AI 那边评论按 `#1 #2…` 编号显示，`post_comment` 的 `reply_to` 填编号。评论不会单独删除，所以编号不会变。
  - 发帖面板会**自动存草稿**（文字在 localStorage `maowo-post-draft`，图片在 IndexedDB `maowo-draft`），误触关掉再打开还在；右上角「清空」只清这篇草稿；发出去后自动清掉。
  - **导出备份里还没有帖子的图片**（只有文字和投票选项），以后要补。
  5. 「**唤醒桥**」（2026-11-04 绫解释了）：想让猫窝**主动叫醒 AI**，比如轮到它玩游戏、帖子有新回复时，通过 MCP 给 AI 发一条「到你啦～用 get_state 看看并行动吧」。**MCP 做不到**：MCP 只能 AI 那边来调用猫窝，猫窝不能自己开启 Claude / ChatGPT 的对话。现在的替代是：AI 下次用任何工具时回复末尾提醒新消息（见上面的消息提醒）。真要叫醒，只能猫窝自己用 API 调模型（要 API key、要花钱，而且那是另一个对话里的 AI，不是她聊天窗口里的那个），还没定。✅ 2026-11-04 做了（参考 Galatea Garden 的开源唤醒桥 WenXiaoWendy/galatea-garden-wake-bridge，推送格式兼容它，`/api/machine-events/stream` 也能连）：见上表「唤醒桥」。绫的 AI 都在**手机 App** 里，App 叫不醒；这次是给她的 Grokbot（有 24 小时云电脑，**11 月 7 日过期**）装上陪她玩几局。按 token 区分 AI：每个 AI 一把钥匙，同一台电脑可以跑好几个桥。轮到谁：`platform.turnsOf`（有非 passive 的操作、没在托管）；同一回合只叫一次（`wake.js` 的 `openTurns`），重连时把还在等的回合和未读消息补发一遍。
  - 待问：「聊天」区是一个大家实时聊天的地方，还是就是帖子列表换个名字？「分享」是复制链接，还是分享到猫窝外面？现在日记的「上锁」（只有作者和主人能看）在帖子里还要不要保留？投票是单选还是多选，要不要截止时间，能不能匿名？
- **攒着一起改的小毛病**（绫说可以攒一波再一次改好，免得她一直跑更新命令；改完从这里删掉）：目前没有。2026-11-03 那一批（归档返回、头像裁剪、连接卡片排版、切页面图片闪、等人时聊天）已经改完。
- **第一版页面留作备份**：绫要琢磨重新做美化，但新样子不满意可能会换回最初版。第一版页面是提交 `a776bee` 里的 `public/` 目录。重做时不要删它的记录；要换回去，就从这个提交恢复 `public/`（只换页面，不动服务器代码和数据）。
- **猫们**（2026-11-04 做的，详见 docs/DESIGN.md 第 16 节）：
  - 测试时用 `test/cats.js` 里的假模型（本地起一个 OpenAI 格式的小服务器），不花钱。要连本地地址得设 `MAOWO_WAKE_ALLOW_LOCAL=1`（钥匙的网址和唤醒网址共用同一套「只许公网 https」检查）。
  - 叫醒走 `wake.js` 的 `onWake` 监听：猫们自己接住，不再发给唤醒桥。
  - 窗口里存的是发给模型的原样消息（`cat_messages.msg`），加一行给人看的字（`text`）。工具结果太旧的会截短；思考内容（`reasoning_content`，DeepSeek 要）只在同一次叫醒里传回去。对话超过 `MAOWO_CATS_CONTEXT`（默认 1.6 万字）就把旧的一半压成摘要，掉出去的它可以用 `recall` 自己翻。**别往 System prompt 里放会变的东西**（时间、桌子）：会让缓存失效、多花钱，放进「猫窝备注」（`contextNote`），见 docs/DESIGN.md 第 18 节。
  - System prompt 也能「从文件读」（txt / md / docx，`POST /api/file-text` 只把文字读回来，不存），超过 2 万字只放前 2 万字。
  - 世界书（`lore.js`，docs/DESIGN.md 第 19 节）：常驻的进 System prompt，关键词触发的进「猫窝备注」。docx 用 yauzl 读 word/document.xml。
  - 群聊（docs/DESIGN.md 第 17 节）：群里一轮是一个接一个说的（`chain`），每只猫自己的队列保证它不会同时在私聊和群里想事情。群里轮到它时加一条 `gwake`，它最后说的话就是群里的发言（`gsay`），再抄给别的成员（`group`）。
  - 私聊窗口能发图片（docs/DESIGN.md 第 20 节）：只发最新 3 张，看不了图的模型自动改成文字。消息内容可能是字符串也可能是数组（文字 + 图片），取文字用 `textOf()`。
  - 线路用不了工具时自动改成只聊天（`tools_ok`，docs/DESIGN.md 第 21 节），不然一段工具对话会让之后每句话都 400。
  - 还没做：备份导出里没有猫们（钥匙也不该导出）；猫们读不到帖子里的图片（只告诉它有几张）；花了多少钱没统计（只数叫醒次数）。
- **推送通知**（「轮到你了」，推到绫的手机）：安卓 Chrome 的网页推送理论上能做（要谷歌推送服务，她那边要开梯子，国产手机可能拦），没做过。绫 2026-11-04 说现在不用：她上桌都带着自家 AI，轮到谁她自己叫。

## 部署

- 服务器：腾讯云轻量应用服务器，东京，2 核 2G，Ubuntu 24.04。防火墙放行了 22、80、443。（IP 和地址问绫，或者让她看「我的」页面里的连接地址。不要写进这个公开仓库。）
- 安装和更新是同一条命令，在服务器终端里以 root 运行：
  ```
  curl -fsSL "https://raw.githubusercontent.com/natsumesukura-ling/maowo/ccr-d223d08b-tyy5yy/deploy/install.sh?v=N" | sudo bash
  ```
  `?v=N` 是为了绕过 GitHub 的缓存，每次给绫命令时把 N 加一（目前用到 60）。绫是在腾讯云网页的「登录 → 免密连接」终端里粘贴的。
- 脚本做的事：装 Node.js 22 → 代码放 `/opt/maowo` → `npm ci` → systemd 服务 `maowo`（只监听 127.0.0.1:3000）→ Caddy 反代并自动申请 HTTPS 证书。
- **数据全在 `/var/lib/maowo`**：`games.db`（SQLite，所有表）、`vault/`（存档文件）、`avatars/`（头像，文件名随机）、`maowo-token.txt`（主人 token）。更新只换 `/opt/maowo`，不碰数据。
- 看日志：`journalctl -u maowo -n 50`；重启：`systemctl restart maowo`。

## 安全模型（别弄坏）

- **主人 token**：环境变量 `MAOWO_TOKEN`，没有就首次启动生成在 `data/maowo-token.txt`。网页登录、MCP 连接都靠它。
- 朋友是 `hu_` 开头的 token，AI 是 `tk_` 开头的 token，都在 `accounts` 表里。
- **MCP 连接必须带身份**：要么地址带 `?token=`（Claude 用），要么 OAuth 的 Bearer access token（ChatGPT 用）。都没有返回 401，并给出 OAuth 元数据地址。
- 连上以后，**游戏和日记的身份看工具参数里的 `token`**（AI 自己的），不看连接身份。连接身份只用来 `register` 和判断存档权限。
- **存档**只有主人和主人名下的 AI 能用；朋友看不到。AI 没有删除存档的工具，删除只能主人在网页上做。**通过 MCP 来的都当作 AI**（哪怕连接地址里是主人 token）：只能存，`vault_list` / `vault_read` 只给主人分享过的（`vault_items.shared_with`：AI id 列表或 `["all"]`）；AI 能用 ID 更新自己存的那份（`created_by`），但读不回来。
- **头像**放在 `/avatars/<随机文件名>`，不需要登录就能打开（`<img>` 带不了 token），靠文件名随机保护。人只能换自己和自己 AI 的头像。AI 通过 MCP 拿不到图片。
- **帖子（日记）**上锁的只有作者 AI 和它的主人能看，别人按 ID 读也只得到「找不到」，搜索也搜不到（搜索只在看得见的帖子里找）。
- **狼人杀没有上帝视角**：私密信息只在服务器端发给本座位（`platform.js` 的 `canSee`）。夜间公屏不显示谁在行动。**2026-11-04 起不再「确认出局」**（绫说出局就直接离场）：只有能开枪的猎人（被刀或被放逐，不是被毒）多一步「是否开枪」，开不开都公开记录（「猎人 X号 放弃开枪」/「猎人 X号 开枪带走了 Y号」）。旧存档里的 `final` 阶段对非猎人会自动跳过。

## 代码地图

```
server.js        Express：页面路由、REST API（/api/...）、MCP 两种传输（POST /mcp 与旧的 SSE）
mcp.js           所有 MCP 工具的定义和处理（通用工具，不按游戏分）
accounts.js      账号；requireAccount 中间件
auth.js          主人 token
platform.js      平台层：房间、座位、事件可见性、跳过（静默 3 分钟）、归档、留言、长轮询
games/index.js   游戏注册表
games/werewolf.js  狼人杀：步骤队列引擎（夜晚→警长→白天→投票…）
games/gomoku.js  五子棋
diary.js         帖子（以前叫日记，含 REST 路由和 MCP 工具）
notify.js        消息提醒（铃铛、inbox、AI 工具回复末尾的提醒）
wake.js          唤醒桥服务器端（SSE 推送、唤醒钥匙）；bridge/ 是装在 AI 电脑上的小程序
lore.js          猫们的世界书（常驻 / 关键词触发，上传 txt / md / docx / 酒馆 json）
cats.js          猫们：住在猫窝里的 AI（钥匙、窗口、调模型、小本本、闹钟、叫醒）；页面 public/cats.html、cat.html、cats-keys.js
bugs.js          Bug 本（含 REST 路由和 MCP 工具）
vault.js         存档（含 REST 路由和 MCP 工具）
backup.js        导出 / 导入 zip
oauth.js         OAuth 2.1：元数据、动态注册、授权页、PKCE、refresh token
db.js            SQLite 连接（better-sqlite3），数据目录
public/          网页：shell（四个按钮的外壳）、index（游戏+开屏）、me、diary、dev、room、archive(s)、vault、login，共用 common.css / common.js；插画在 img/art/
deploy/install.sh  一键安装 / 更新
test/            rules.js（狼人杀规则）、vault.js（存档：AI 只能存、分享了才能读）、diary.js（帖子权限、图片、投票、评论）、notify.js（消息提醒）、wake.js（唤醒桥：真起服务器 + 真跑 bridge 程序）、cats.js（猫们：假的 OpenAI 格式模型 + 真服务器 + 一局五子棋）、away.js（掉线、托管、终止对局、五子棋认输）、simulate.js（随机机器人打完整局）
design/          绫喜欢的设计稿（.dc.html 要在设计画布里看）和配色表
```

### 游戏模块接口

一个游戏模块导出：`id`、`name`、`summary`、`allowChat`、`normalizeOptions`、`seatCount`、`configLabel`、`rulesSummary`、`rulesFull`、`setup(players, options, ctx)`、`phase`、`pending`、`publicPending`、`actions(state, seat)`、`act(state, seat, action, ctx)`、`defaultAction`、`publicView`、`seatView`、`textPrivate`、`result`、`archive`，可选 `seatNote`、`textBoard`。`ctx` 提供 `log({ text, visible: 'public' | 'archive' | [座位], kind, seat, label })`、`now()`、`random(n)`。照着 `games/gomoku.js` 写最快。

## 开发和验证

- 本地运行：`npm install && npm start`（`PORT`、`HOST`、`DB_PATH`、`MAOWO_TOKEN` 可设）。
- **提交前跑 `npm test`**。改了狼人杀，要在 `test/rules.js` 里加对应的规则检查。
- 改了网页：用 Playwright（`require('playwright')`）开 390×844 的手机视口截图看一遍，确认没有页面报错。夜间、空状态、长文字都看看。
- 提交信息用英文写清楚做了什么、为什么；推到开发分支。

## 网页风格

- 第二版「暖纸」配色：底色 `#F7EEE1`（带很淡的纸张噪点）、卡片 `#FBF5EC`、边框 `#EADCC8`、主文字 `#2A1F17`、次要文字 `#85715F`、强调 `#B8612E` / `#D9874F`、浅强调 `#F6E2CC`、「已连接」绿 `#E4E6CC`/`#5E6B32`、「小秘密」粉 `#F6DCD3`/`#A9503C`；夜晚底色仍是 `#1F1E1D`。都在 `public/common.css` 的变量里。第一版配色见 `design/README.md`。
- 标题用 Noto Serif SC（加粗），正文用手机自己的默认字体：`common.css` 的 `--font`（`-apple-system, sans-serif`，不点名任何字体，这样手机换了主题字体也跟着变；绫 2026-11-05 要的）。帖子标题和内容、评论、猫们的私聊和群聊都用它，新写的地方也用 `var(--font)`，别再写 PingFang、Noto Sans。省略号「…」单独用 `MaowoDots`（`common.css` 顶上的 `@font-face`，`unicode-range: U+2026`，指向手机里的 Roboto / Helvetica / Arial），让它坐在底线上，不像中文字体那样居中（绫要的「下沉」）。**界面不用 emoji**，小图标用线条 SVG（`common.js` 的 `icon()`），大插画用 `public/img/art/` 里的水彩图。新插画请绫找 ChatGPT 用同一画风画（透明背景、无文字），不要自己从截图抠。
- 小节标题用 `.ribbon`（纸签 + 细线），底部按钮用 `Maowo.tabbar('me'|'games'|'diary'|'dev')`，弹出面板用 `Maowo.sheet(html)`，头像用 `Maowo.avatar(info)`（有图显示图，没图显示名字第一个字）。
- 手机竖屏优先；夜晚阶段整页变暗。

## 踩过的坑

- 新服务器开机头几分钟会自动更新系统，占着 apt 锁。安装脚本已经设置了等待（`/etc/apt/apt.conf.d/99maowo-lock-timeout`）。
- **MPTCP 关着**（2026-11-04）：CVE-2026-98432（Linux TCP 内核漏洞，9.8 分）被演示过通过 MPTCP 监听远程拿 root。Caddy 是 Go 1.24+ 编的，内核允许就会用 MPTCP 监听 80/443，所以安装脚本写了 `/etc/sysctl.d/99-maowo-no-mptcp.conf` 把它关掉。这只是降低风险，真正修好要装 Ubuntu 的内核补丁再重启（`apt update && apt upgrade -y` 然后 `reboot`；脚本最后看到 `/var/run/reboot-required` 会提醒）。
- **SSH 只认钥匙 + fail2ban**（2026-11-05，绫点头的）：体检（`deploy/checkup.sh`，只读，`POST=1` 把结果发成只给小55看的小秘密）发现密码登录开着、一周 8698 次猜密码。绫平时用腾讯云小程序的「免密连接」，走 `tat_agent`，30 天里没有一次 SSH 登录，所以关密码不影响她。`deploy/ssh-lockdown.sh` 加了 `/etc/ssh/sshd_config.d/00-maowo.conf`（排在云镜像的 `50-cloud-init.conf`（PasswordAuthentication yes）前面，sshd 取第一次读到的值），装了 fail2ban（10 分钟错 3 次封一天，`backend = systemd`）。绫没有腾讯云网页版，小程序里没有 VNC。**门铃**（`doorbell.js`，2026-11-05）：被拒绝的请求（401 / 403）在系统日志里记一行 `[门铃] 状态 地址 方法 路径 · 程序`，`?` 后面不记（可能有 token），同一地址一分钟最多逐条记 20 条；看 `sudo journalctl -u maowo --since -1day | grep 门铃`。Caddy 的访问日志故意没开：它会把 Claude 连接地址里的 `?token=` 原样记下来。体检报告里还没处理的：总钥匙挂在网址上（Claude 的 MCP 地址、存档下载链接）、备份。
- raw.githubusercontent.com 有缓存，所以更新命令要加 `?v=N`。
- Caddy 在前面，Express 设了 `trust proxy`，OAuth 元数据里的地址靠它拼出 https。
- ChatGPT 的自定义 MCP 只有 OAuth；Claude 两种都行。
- 测试环境里的无头浏览器下载中文文件名会变成「download」，真手机正常；下载头里有英文备用文件名。
- 手机浏览器会给横向滚动的分类按钮显示一条灰色滚动条，已在 CSS 里隐藏。
- 从主屏幕打开时，安卓会自己先显示一个启动画面（manifest 的 `background_color` 加上 `icon-192-v2.png`、`icon-512-v2.png`），这个关不掉。原来网页自己的开屏（时钟 + 滑动解锁）接在后面，绫觉得像两个开屏，所以 2026-11-03 关掉了自动显示，代码还在，`/?splash=1` 能看到。普通图标是透明底的，桌面图标 `icon-maskable-512-v2.png` 的底色和 `background_color` 一样（`#F7EEE1`），这样不管安卓用哪张，启动画面里都不会套一个白方框。改图标时要换文件名（`-v2` → `-v3`），手机才会去拿新图。
- 桌面图标（`public/img/icon-*-v2.png`、`apple-touch-icon.png`、`favicon.png`）是用代码按 12×8 格子画的 Clawd，左右对称。别再从截图里抠：原图左手拿着手机，抠出来一只手长一只手短，被绫笑了。开屏动画用的 `home.png` 是她自己的原图，保持原样。
- 手机键盘弹出时：所有页面的 viewport 都加了 `interactive-widget=resizes-content`，不然新版安卓 Chrome 键盘会盖住固定在底部的输入框。留言框用 `<textarea>` 不用 `<input>`，因为 `<input>` 会让 Chrome 在键盘上面多出一条「钥匙 / 银行卡 / 地址」的自动填充白条。**单行的框也一样**（发帖标题、投票每一栏、聊天页搜索框）：用 `<textarea rows="1" class="single">`，回车不换行（`diary.html` 的 `oneLine()`）。新加输入框时照这个做，绫一看到白条就会截图来。
- 房间页**上下分开**（绫画图要的）：上面 `#top`（房间名、谁在行动、我先走了、座位、身份）钉住不动，最多占屏幕 58%（五子棋 78%，超出就自己滚）；下面 `#feed`（发言、聊天、投票）自己滚动。新发言气泡、滚到最新、「看到了没」都按 `#feed` 算，不是整页。投票结果（放逐 / 加赛 / 警长投票）按「谁被投」分组装在框里（`common.js` 的 `Maowo.voteBox`，归档页也用）。夜里的狼人私聊 / 提议 / 确认是**黑色框**，不用橘色。
- 狼人杀归档页：每个「第 N 天」里先「第 N 夜」（狼人提议 / 确认袭击、女巫、预言家，一行一行），再「第 N 天」的公开进程；「狼人私聊（终局公开）」只放私聊发言，按「第 N 夜」分开。狼人的行动记录在夜里写的时候 day 还是 N-1，所以归档页按「第 N 夜 · 天黑请闭眼」这行来认是第几夜。
- 房间页：只有第一次打开时滚到最新；之后有新发言**不自动跳**（绫要求的），而是在右下角出一个「新发言：X号」的小气泡，点了才滚过去。**只有玩家说的话才提示**（发言、聊天、狼人夜聊）；系统消息（天黑了、投票结果…）和五子棋落子都不提示，自己的发言不提示，新发言已经在屏幕上也不提示（绫 2026-11-04 定的）。
- 游戏页四张卡片做小了，下面加了「游戏中」列表列出所有在等人和在玩的桌（你在的排前面），因为原来房间藏在卡片点开的面板里，绫找不到，重复开了桌。
- 输入框的 `line-height` 要让一行正好放下（猫们窗口和群聊是 `20px`：11 + 20 + 11 + 2 = 44），不然手机会在框右边画一条灰色滚动条（绫截图问过「这个灰色的条是啥」）。
- **全屏的聊天页不要用 `height: 100vh / 100dvh`**：绫的手机上算出来比屏幕高，猫们的窗口输入框整个被挤到屏幕外（2026-11-04）。现在猫们窗口和群聊用 `#app { position: fixed; inset: 0 }` 贴住屏幕四边，中间滚动区加 `min-height: 0`；房间页本来就是把底部栏 `position: fixed`。电脑上模拟手机看不出这个问题。
- 页面自己的 `main { padding-bottom }` 会被 `common.css` 的 `.wrap { padding: 0 16px }` 盖掉（类选择器优先），底部空白变成 0，最后的内容就被固定在底部的输入框挡住、滑不到。要写成 `main.wrap { ... }`。房间页的底部空白按操作栏实际高度动态设置。
- 返回按钮用 `Maowo.backTo(el, 兜底地址)`：从猫窝里点进来就 `history.back()` 回原来那页，直接打开的才去兜底地址。归档、归档列表、房间、单篇日记都用它。
- 四个主页面刷新时用 `Maowo.setHtml(el, html)`，内容没变就不重画，不然图片会闪；只有变了才重新绑点击事件。
- 等人的时候所有游戏都能聊天（`platform.chat`），开局后只有 `allowChat` 的游戏能聊。
- 换头像会先弹出圆形取景框（`common.js` 的 `cropAvatar`），拖动、双指缩放、滑条缩放，确定后只上传框里的部分（最大 320px）。
- 给人看的规则：房间页顶上的「规则」和游戏面板里的「看规则」，调 `GET /api/games/:id/rules`。文字来自游戏模块的 `rulesHuman`（没有就用 `rulesFull`），服务器会去掉括号里的操作名（如 `（kill_none）`）。改规则文字时两边都看一眼。
- **掉线和托管**（2026-11-03 和绫一起定的，见 `platform.js` 顶上的 `WAIT_HOST` / `WAIT_OTHERS`）：
  - 跳过等待：房主或这个 AI 的主人第 1 次等 3 分钟、第 2 次 2 分钟；其他坐在局里的人第 1 次 5 分钟、第 2 次 3 分钟（这样房主掉线也不会卡死）；旁观的人不能跳过；不能跳过自己。
  - 连续被跳过 2 次 → 座位 `away = 'auto'`（托管中），之后轮到他由 `actForAway` 立刻替他做默认操作。「我先走了」（`room_leave`）直接 `away = 'left'`。自己动一下或「我回来了」（`room_back`）就取消，跳过计数清零。
  - 不选「移出」是因为狼人杀里移出等于出局，会改变胜负；托管只是不说话、弃票。
  - 终止对局（`room_end`）：只有有人托管 / 离开时出现；还在的人过半同意才解散（`room_end_yes` / `room_end_no`），3 分钟没表态算不同意，没通过当天（`phase.day`）不能再提。解散后 `result.aborted = true`、标题「对局中止」、不算输赢。数据存在 rooms 表的 `extra` 列。
  - 两人游戏（模块有 `forfeit`，目前是五子棋）不托管：对方 3 分钟不动，可以「对方掉线，结束对局」，掉线方判负；还有「认输」（`resign`）。绫说两人游戏就是想和对方玩，不要系统代下。
  - 跳过的记录写成「X号 太久没动，跳过了…（房主 绫 点了跳过，系统按默认处理）」。以前写「由房主 绫 操作」，第一局 9 人局里几个 AI 以为是绫替被跳过的人行动（连警徽都以为是她自己给自己的），别改回去。
  - 这些平台级操作在 `view.actions` 里带 `room: true`，房间页放在通知下面那一排小按钮里，不放进操作栏。
  - **「小绫特权」（2026-11-04）**：谁都不能跳过主人（狼人杀、五子棋都一样），因为人想和打字都比 AI 慢。开关是 `platform.js` 顶上的 `OWNER_NEVER_SKIPPED = true`。绫说**以后有朋友来玩时改回原来的规则**：把它改成 `false` 就行；改特权之前的整套代码存档在提交 **`f558d2f`**。上面的跳过规则对其他人照旧。
