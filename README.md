# dsh-myosotis · Myosotis

> 给 DSH 的三层持久记忆：**全局 / 项目 / 会话**。每轮按当前话题自动挑几条注入上下文，模型用三个工具维护它，用户可以直接读 `MEMORY.md`。

DSH 自带的 `session_search` 能在历史里翻原文；Myosotis 记的是**结论**——你是谁、你们约过什么、这个仓库有什么坑、上次那件事最后怎么收的场。

- 零依赖：只用 `node:` 内置模块，配置校验自己实现 Standard Schema 协议
- 零模型调用：检索是词法 + 权重的确定性打分，注入在请求路径上是毫秒级
- 记忆是可读的：JSON 是真相，`MEMORY.md` 是给人看和给 git 看的投影
- 不打扰：注入的是一段背景资料，不是新指令；写坏了也不影响对话，最差是这一轮没记忆

## 三层记忆

| 层              | 放什么                     | 存在哪                                    | 生命周期              |
| -------------- | ----------------------- | -------------------------------------- | ----------------- |
| **global** 全局  | 用户偏好、习惯、身份、你们之间的经历与相处方式 | `<DSH_HOME>/memory/global.json`        | 永久，跟着人走           |
| **project** 项目 | 技术栈、开发规范、架构决策、踩过的坑      | `<cwd>/.dsh/memory/project.json`       | 永久，跟着仓库走，可提交进 git |
| **session** 会话 | 这次对话的临时线索、自动捕获的「记住…」    | `<DSH_HOME>/memory/sessions/<id>.json` | 默认 30 天过期         |

三层的区别不是「重不重要」，而是**该跟谁走**：换个项目还成立的写 global，只有这个仓库成立的写 project，只在这次对话成立的写 session。

## 安装

插件放在 `~/.dsh/local-plugins/`，并在 profile 里登记。仓库自带脚本：

```bash
node tools/install.mjs            # 安装到 desktop profile
node tools/install.mjs --dry-run  # 只看会改什么
node tools/install.mjs --uninstall
```

装完重启 DSH 生效。手动安装等价于三步：

1. 把本目录复制到 `~/.dsh/local-plugins/dsh-myosotis`
2. `~/.dsh/profiles/desktop/package.json` 里加依赖  
   `"dsh-myosotis": "link:C:/Users/<你>/.dsh/local-plugins/dsh-myosotis"`，  
   并在 `dsh.profile.bundles` 数组末尾加 `"dsh-myosotis"`
3. 在 `~/.dsh/profiles/desktop/node_modules/` 下建一个指向第 1 步目录的链接

## 用起来是什么样

第一轮：

> **你**：记住，以后提交信息一律用中文，不要自动 push。  
> **Agent**：（调用 `memory_save`，scope=project，kind=convention，importance=5）好，记下了。

下一轮（同一个项目，新开一个会话）：

> **你**：帮我把这个改动提交了。  
> **Agent**：（上下文里已经有「提交信息一律用中文，不要自动 push」）……（写完提交信息，但不会 push）

再换一个项目，这条约定不会跟过去——因为它在 project 层，不在 global 层。

## 三个工具

| 工具              | 作用             | 关键参数                                                             |
| --------------- | -------------- | ---------------------------------------------------------------- |
| `memory_save`   | 新增 / 更新 / 跨层提升 | `text`、`scope`、`kind`、`importance`、`pinned`、`affect`、`date`、`id` |
| `memory_search` | 检索；不确定时先查      | `query`、`scopes`、`limit`                                         |
| `memory_forget` | 删除；按关键词批量删要先确认 | `id` / `query` + `confirm`                                       |

`memory_save` 给 `id` 是更新，给 `id` 且 `scope` 不同就是**提升**：会话里自动捕获的线索，模型判断值得长期保留后，用同一个 id 把它提到 project 或 global。

`kind` 共九种：`profile`（身份）、`preference`（偏好）、`habit`（习惯）、`convention`（约定）、`decision`（决策）、`fact`（事实）、`gotcha`（坑）、`episode`（经历）、`bond`（关系）。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖，重启生效：

```yaml
- id: memory
  name: dsh-myosotis
  config:
    budgetChars: 3000     # 每轮注入的字符预算
    sessionTtlDays: 14    # 会话记忆过期天数，0 = 不过期
    autoEpisode: true     # 日记模式：每轮自动记一条流水
```

| 键                                         | 默认                    | 说明                           |
| ----------------------------------------- | --------------------- | ---------------------------- |
| `enabled`                                 | `true`                | 总开关；关掉后磁盘上的记忆原样保留            |
| `globalDir`                               | `''`                  | 全局目录；空 = `<DSH_HOME>/memory` |
| `projectDir`                              | `.dsh/memory`         | 项目目录，相对工作目录                  |
| `inject`                                  | `true`                | 是否注入记忆                       |
| `policy`                                  | `true`                | 是否注入「记忆使用规则」段落               |
| `budgetChars`                             | `2400`                | 每轮注入的字符预算                    |
| `maxGlobal` / `maxProject` / `maxSession` | `400` / `300` / `120` | 各层条数上限，超出按保留分数淘汰             |
| `sessionTtlDays`                          | `30`                  | 会话记忆过期天数                     |
| `autoCapture`                             | `true`                | 自动捕获「记住 / 以后都 / 不要再」这类明确指令   |
| `autoEpisode`                             | `false`               | 日记模式（噪声大，默认关）                |
| `episodeMinTools`                         | `2`                   | 日记模式的工具调用门槛                  |
| `markdownMirror`                          | `true`                | 生成 `MEMORY.md` 镜像            |

## 它是怎么工作的

### 注入：每轮重新排序，但不抖动

`memory:recall` 是一个**动态段落**——`systemPrompt.section()` 的 `text` 传函数，每次组装提示词时按「当前这轮用户说了什么」重新选条。

选条的打分：

```
score = 词法相关性 × 2.4        # IDF 加权，标签 3 倍、标题 2 倍、正文 1 倍
      + 重要度 / 5 × 0.7
      + 新近度 × 0.3            # 半衰期 45 天
      + 使用频次 × 0.2          # 对数饱和，最多 +0.2
      + 置顶 × 0.45
      + 情绪强度 × 0.15
```

然后按字符预算截断，**置顶 / 身份 / 关系类永远先入选**——它们回答的是「这个人是谁、我们是什么关系」，不该因为话题不相关就消失。

同一轮里结果会被缓存：只要记忆没变、用户没说话，连续几步（读文件、跑测试、改代码）注入的都是同一段文本，不会把前缀缓存打碎。

### 检索：为什么不是向量

记忆注入在**每一轮请求的组装路径**上。这条路要求：同步、毫秒级、不发网络请求、结果可预测。向量检索要 embedding 调用，这三条全破。

词法检索 + IDF 加权在「几十到几百条人工维护的记忆」这个量级上够用：记忆本来就是人写的短句，用词重叠度很高。代价是同义改写检索不到——所以 `memory_search` 工具留给模型自己换词重试。

### 捕获：规则负责发现，判断留给模型

自动捕获只做**高置信度**的事：用户说「记住 / 以后都 / 不要再 / 我习惯 / 我们约定」时，把那一句落到 **session** 层。

不直接写 global/project 的原因：记错一条偏好，比少记十条更伤。规则能判断「这句话是在下指令」，判断不了「这条该跟人走还是跟仓库走」——后者需要上下文，交给模型。

「你还记得吗」这类问句不会触发捕获（`NOT_A_COMMAND` 拦掉）。

### 存储：同步读、异步写、原子替换

- 读发生在提示词组装路径上，必须同步——文件很小（几百条），一次 `readFileSync` 可以接受
- 写走 120ms 防抖 + 「临时文件 + rename」原子替换，Windows 上对 `EPERM/EACCES/EBUSY` 做短暂重试
- 一个进程内一个文件只有一个实例；多开窗口时是「最后写入者胜」，但任何时刻文件都是完整 JSON

### 卫生规则

写入时自动做三件事，任何入口（工具、自动捕获、CLI）都享受同样待遇：

1. **去重**：文本归一化后完全相同 → 更新而不是新增
2. **合并**：相似度 ≥ 0.85（Jaccard 与包含度取大，长度差太大时只用 Jaccard）→ 合并，保留更长的文本、更高的重要度、标签并集
3. **淘汰**：超出条数上限时按保留分数（重要度 + 频次 + 新近度）淘汰，置顶项永不淘汰

## 情感记忆

这一层是给「把 Agent 当人相处」的用法准备的，但不需要 Agent 扮演任何角色——它只是让记忆**带上当时的分量**。

- `kind: episode` 记共同经历：「2026-10 一起把记忆插件的检索从分作用域 IDF 改成全局 IDF，他发现排序问题时挺兴奋」
- `kind: bond` 记相处方式：「他讨厌客套和总结陈词，直接说结论就行」
- `affect: { label: '挫败', intensity: 4 }` 给记忆标情绪重量；情绪强度会进检索分数
- `date: '03-14'` 记每年重复的日子；注入时会显示「每年 03-14」

`bond` 和 `profile` 一样属于「永远先入选」的那一类——它们不该因为「这轮在聊构建脚本」就被排到预算外面。

提示词里的规则段落会要求模型：阶段性任务收尾、或与用户有一次值得留存的交流后，写一条 episode。**什么时候值得记，是判断，不是规则**——这部分交给模型，插件只负责让它记得住、找得回、不过期。

## 维护

### 命令行（不开 DSH 也能用）

```bash
node tools/memory.mjs stats
node tools/memory.mjs list --scope project
node tools/memory.mjs search 提交信息
node tools/memory.mjs add "提交信息一律用中文" --scope project --kind convention --importance 5
node tools/memory.mjs pin m_xxx
node tools/memory.mjs rm m_xxx
node tools/memory.mjs export --scope global
node tools/memory.mjs path
```

和插件读写同一批文件，改完下一次组装提示词就生效。

### 直接读 Markdown

每次写入后会同步生成 `MEMORY.md`（全局一份、每个项目一份）：

```markdown
# 全局记忆

> 由 dsh-myosotis 自动生成，是 JSON 的只读投影；手改会在下一次写入时被覆盖。
> 要增删改，请让 Agent 用 `memory_save` / `memory_forget`，或运行 `node tools/memory.mjs`。

最后更新：2026-10-24 18:15 · 共 2 条

## 身份

- 用户叫 Kaoruko，喜欢被直呼名字 ★ 

## 关系

- 深夜写代码时容易焦虑，先给结论再解释细节 
```

它是**只读投影**，手改会在下一次写入时被覆盖——文件头里也这么写着。行尾的 HTML 注释是 id，方便对着 CLI 用。要改记忆，走工具或 CLI。

### 文件位置

```
<DSH_HOME>/memory/
├── global.json          # 全局记忆
├── MEMORY.md            # 全局记忆的可读镜像
├── sessions/
│   └── <sessionId>.json # 每个会话一份，默认 30 天过期
└── projects/
    └── <hash>.json      # 工作目录不可写时的项目记忆回退

<cwd>/.dsh/memory/
├── project.json
└── MEMORY.md
```

## 注入长什么样

`node tools/demo.mjs "TypeScript 的 any 怎么处理"` 的输出（临时环境，跑完即删）：

```text
### 关于用户
- [偏好] 偏好 TypeScript 严格模式，不接受为了省事加 any
- [身份] 用户叫 xxx，喜欢被直呼名字，讨厌客套和总结陈词
- [关系·在意] 深夜写代码时容易焦虑，先给结论再解释细节
- [经历·兴奋] 2026-10 一起把检索从分作用域 IDF 改成全局 IDF，他发现问题时很兴奋

### 本项目 · DSH-Myosotis
- [约定] 提交信息一律用中文，不要自动 push
- [坑] 这个仓库用 pnpm，不要引入 npm 的 lock 文件

### 本次会话
- [事实] 这轮在调记忆注入的预算
```

同一个环境换一句「帮我提交一下代码」，`约定` 会排到 `坑` 前面，`偏好` 会掉到 `身份` 后面——排序跟着这一轮的话题走，但 `身份`/`关系` 这类永远在名单里。

## 测试

```bash
node --test "tests/*.test.mjs"   # 或 npm test
```

56 个用例覆盖文本层、存储层（去重 / 合并 / 淘汰 / 过期 / 落盘）、检索层（相关性 / 置顶 / 预算）、服务层（三层落盘 / 提升 / 检索 / 删除 / 注入 / 镜像）和插件装载（假 ctx 验证段落与工具注册、自动捕获、工具全链路、配置校验）。

其中 `tests/runtime.test.mjs` 会去找本机的 DSH 运行时，用真的 `@deepseek-ai/cordis` + `dsh-system-prompt` + `dsh-tools` 装载插件——工具 schema 不合法、依赖注入写错这类问题只会在真环境暴露，找不到运行时则整组跳过。

## 已知限制

- **没有语义检索**：换个说法就搜不到，靠模型自己换词。这是刻意的取舍，见上文。
- **多进程并发是最后写入者胜**：同一个文件被两个进程同时写时，后写的覆盖先写的。原子替换保证不出现半个 JSON，但会丢更新。单机单实例场景不受影响。
- **会话记忆不会自动沉淀**：自动捕获只落在 session 层，要长期保留得靠模型主动提升。这是「宁可漏不可错」的代价。
- **`MEMORY.md` 是单向投影**：手改无效。

## License

MIT
