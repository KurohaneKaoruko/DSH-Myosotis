# dsh-myosotis · Myosotis

> 给 DSH 的四层持久记忆：**全局 / 项目 / 会话 / 深记忆**。前三层每轮按当前话题挑几条注入上下文，深记忆用 SQLite 存量大归档、按需检索。模型用三个工具维护它，用户可以直接读 `MEMORY.md`。

DSH 自带的 `session_search` 能在历史里翻原文；Myosotis 记的是**结论**——你是谁、你们约过什么、这个仓库有什么坑、上次那件事最后怎么收的场。

- 零依赖：只用 `node:` 内置模块（SQLite 走 Node 自带的 `node:sqlite`），配置校验自己实现 Standard Schema 协议
- 零模型调用：检索是词法 + 权重的确定性打分，注入在请求路径上是毫秒级
- 记忆是可读的：JSON 是真相，`MEMORY.md` 是给人看和给 git 看的投影
- 不打扰：注入的是一段背景资料，不是新指令；写坏了也不影响对话，最差是这一轮没记忆

## 四层记忆

| 层 | 放什么 | 存在哪 | 生命周期 |
| --- | --- | --- | --- |
| **global** 全局 | 用户偏好、习惯、身份、你们之间的经历与相处方式 | `<DSH_HOME>/memory/global.json` | 永久，跟着人走 |
| **project** 项目 | 技术栈、开发规范、架构决策、踩过的坑 | `<cwd>/.dsh/memory/project.json` | 永久，跟着仓库走，可提交进 git |
| **session** 会话 | 这次对话的临时线索、自动捕获的「记住…」 | `<DSH_HOME>/memory/sessions/<id>.json` | 默认 30 天过期，过期后沉淀进深记忆 |
| **deep** 深记忆 | 整段复盘、历史细节、日记、导入的旧记忆 | `<DSH_HOME>/memory/deep.db`（SQLite） | 永久，按条数上限淘汰 |

前三层的区别不是「重不重要」，而是**该跟谁走**：换个项目还成立的写 global，只有这个仓库成立的写 project，只在这次对话成立的写 session。

第四层是另一个维度：**深记忆默认不进上下文**。前三层加起来几百条就到头了，再往里塞会挤占上下文；深记忆可以有上万条，只在被检索到时浮出来。

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

## 深记忆：SQLite 归档层

前三层是「每轮都要读得完」的精选记忆，几百条就到头。真正让记忆有厚度的是第四层：

- **写进去**：`memory_save` 带 `scope: "deep"`；或者把一条精选记忆沉底（`memory_save` 给 `id` + `scope: "deep"`）
- **捞出来**：`memory_search` 默认就把深记忆一起搜，结果里标 `scope: "deep"`
- **自动沉淀**：会话记忆过期后不丢，直接归档进深记忆
- **自动浮现**：当前输入和某条深记忆强相关时，注入块末尾会多一段「相关往事」，只给日期 + 类型 + 一句话，细节靠 `memory_search` 取
- **日记模式**：`autoEpisode: true` 时，每轮结束往深记忆写一条流水（做了什么、用了哪些工具、碰了哪些文件）

### 为什么是 SQLite，而不是再开一个 JSON

前三层是「全量读进内存 + 每轮排序」，JSON 足够。深记忆的量级是几万条，需要的是**增量检索**，不是全量加载。SQLite 正好：单文件、事务、索引、全文检索，而且 Node 22.5+ 自带 `node:sqlite`——不需要 better-sqlite3，不需要编译，仍然是零依赖。

### 中文怎么建索引

FTS5 默认的 `unicode61` 分词器会把一整句中文当成一个词，中文根本搜不出来。所以索引建在**自己分词后的 token 串**上：

```
"提交信息一律用中文"  →  tokens: "提交 交信 信息 一律 律用 用中 中文 …"
```

查询也走同一套分词，`MATCH '"提交" OR "信息"'` 就能命中——两字词也能搜（trigram 分词器在这里反而不行，它要求至少三个字符）。标签和类型也进 token 串，所以搜 `git` 能命中打了 git 标签的记忆。

FTS5 建不出来时（裁剪过的 SQLite 构建）自动退回 `LIKE '% token %'`，慢一点，但不会不能用。

### 拿不到 SQLite 怎么办

`node:sqlite` 不存在（老运行时）时，深记忆整层静默禁用：前三层照常工作，`memory_save({scope:"deep"})` 会返回一句明确的错误，其它什么都不受影响。DSH 桌面端跑的是 Node 24，默认可用。

## 三个工具

| 工具              | 作用             | 关键参数                                                             |
| --------------- | -------------- | ---------------------------------------------------------------- |
| `memory_save`   | 新增 / 更新 / 跨层移动 | `text`、`scope`、`kind`、`importance`、`pinned`、`affect`、`date`、`id` |
| `memory_search` | 检索（含深记忆）       | `query`、`scopes`、`limit`                                         |
| `memory_forget` | 删除；按关键词批量删要先确认 | `id` / `query` + `confirm`                                       |

`memory_save` 给 `id` 是更新，给 `id` 且 `scope` 不同就是在四层之间**移动**：往 `deep` 是沉底归档，从 `deep` 回精选层是提起来。会话里自动捕获的线索，模型判断值得长期保留后，用同一个 id 把它提到 project 或 global。

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
| `autoEpisode`                             | `false`               | 日记模式：每轮往深记忆记一条流水             |
| `episodeMinTools`                         | `2`                   | 日记模式的工具调用门槛                  |
| `markdownMirror`                          | `true`                | 生成 `MEMORY.md` 镜像            |
| `deep`                                    | `true`                | 启用 SQLite 深记忆                |
| `deepPath`                                | `''`                  | 深记忆库路径；空 = `<DSH_HOME>/memory/deep.db` |
| `deepMax`                                 | `20000`               | 深记忆条数上限，超出按保留分数淘汰            |
| `deepRecall`                              | `2`                   | 每轮自动浮现几条相关往事；`0` = 不浮现       |
| `deepRecallMin`                           | `1.6`                 | 浮现的分数门槛，越高越保守                |
| `deepAutoArchive`                         | `true`                | 会话记忆过期后沉淀进深记忆，而不是直接丢弃        |

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

「词法相关性」是**归一化后的命中比例**：分母只算「语料里真的出现过」的查询词，所以 `1.0` 表示每个词都在正文里命中，标签命中会超过 1。这样同一句查询在 5 条记忆和 5000 条记忆里分数可比——否则任何阈值（比如深记忆的浮现门槛）都会随语料规模失效。

然后按字符预算截断，**置顶 / 身份 / 关系类永远先入选**——它们回答的是「这个人是谁、我们是什么关系」，不该因为话题不相关就消失。

同一轮里结果会被缓存：只要记忆没变、用户没说话，连续几步（读文件、跑测试、改代码）注入的都是同一段文本，不会把前缀缓存打碎。

### 检索：为什么不是向量

记忆注入在**每一轮请求的组装路径**上。这条路要求：同步、毫秒级、不发网络请求、结果可预测。向量检索要 embedding 调用，这三条全破。

词法检索 + IDF 加权在「几十到几百条人工维护的记忆」这个量级上够用：记忆本来就是人写的短句，用词重叠度很高。代价是同义改写检索不到——所以 `memory_search` 工具留给模型自己换词重试。

### 捕获：规则负责发现，判断留给模型

自动捕获只做**高置信度**的事：用户说「记住 / 以后都 / 不要再 / 我习惯 / 我们约定」时，把那一句落到 **session** 层。

不直接写 global/project 的原因：记错一条偏好，比少记十条更伤。规则能判断「这句话是在下指令」，判断不了「这条该跟人走还是跟仓库走」——后者需要上下文，交给模型。

「你还记得吗」这类问句不会触发捕获（`NOT_A_COMMAND` 拦掉）。

日记模式（`autoEpisode`）不一样：它写的是**流水**，量大、价值密度低，所以直接进深记忆，不占精选层。

### 存储：同步读、异步写、原子替换

- 读发生在提示词组装路径上，必须同步——文件很小（几百条），一次 `readFileSync` 可以接受
- 写走 120ms 防抖 + 「临时文件 + rename」原子替换，Windows 上对 `EPERM/EACCES/EBUSY` 做短暂重试
- 一个进程内一个文件只有一个实例；多开窗口时是「最后写入者胜」，但任何时刻文件都是完整 JSON
- 深记忆那层是 SQLite：`WAL` 模式、单条写入走事务（正文行与 FTS 行一起提交或一起回滚）

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

# 深记忆
node tools/memory.mjs deep stats
node tools/memory.mjs deep list --limit 30
node tools/memory.mjs deep search 状态机
node tools/memory.mjs deep add "2026-10 那次重构把状态机拆成了三个 reducer" --kind episode
node tools/memory.mjs deep rm m_xxx
node tools/memory.mjs deep export backup.json
node tools/memory.mjs deep import backup.json
node tools/memory.mjs deep vacuum
```

和插件读写同一批文件（深记忆读写同一个 `.db`），改完下一次组装提示词就生效。

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
├── deep.db              # 深记忆（SQLite：memories + memories_fts）
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

### 相关往事
- 2026-10-26 · [经历] 2025-03 那次也卡在同样的检索排序上，最后是靠把 IDF 提到整池才算对
```

同一个环境换一句「帮我提交一下代码」，`约定` 会排到 `坑` 前面，`偏好` 会掉到 `身份` 后面——排序跟着这一轮的话题走，但 `身份`/`关系` 这类永远在名单里。

最后那段「相关往事」来自深记忆：只有当前输入和某条归档强相关时才会出现，而且只给一行摘要——它只是提醒「有这么一件事」，细节要模型自己 `memory_search` 去取。换一句无关的话（比如「帮我写个 CSS 动画」），这一段就不出现。

## 测试

```bash
node --test "tests/*.test.mjs"   # 或 npm test
```

79 个用例覆盖文本层、存储层（去重 / 合并 / 淘汰 / 过期 / 落盘）、检索层（相关性 / 置顶 / 预算）、深记忆层（FTS 与 LIKE 两条路径 / 项目隔离 / 更新换索引 / 淘汰 / 事务）、服务层（四层落盘 / 移动 / 检索 / 删除 / 注入 / 沉淀 / 镜像）和插件装载（假 ctx 验证段落与工具注册、自动捕获、工具全链路、配置校验）。

其中 `tests/runtime.test.mjs` 会去找本机的 DSH 运行时，用真的 `@deepseek-ai/cordis` + `dsh-system-prompt` + `dsh-tools` 装载插件——工具 schema 不合法、依赖注入写错这类问题只会在真环境暴露，找不到运行时则整组跳过。`tests/deep.test.mjs` 在没有 `node:sqlite` 的运行时上整组跳过，和插件自身的降级口径一致。

## 已知限制

- **没有语义检索**：换个说法就搜不到，靠模型自己换词。这是刻意的取舍，见上文。
- **多进程并发是最后写入者胜**：同一个文件被两个进程同时写时，后写的覆盖先写的。原子替换保证不出现半个 JSON，但会丢更新。深记忆那层走 SQLite 事务，单条写入是原子的，跨进程仍是最后写入者胜。单机单实例场景不受影响。
- **会话记忆不会自动进精选层**：自动捕获只落在 session 层，要长期保留得靠模型主动移动（或等它过期后自动沉进深记忆）。这是「宁可漏不可错」的代价。
- **深记忆依赖 `node:sqlite`**：Node 22.5+ 内置，DSH 桌面端跑 Node 24 默认可用；更老的运行时整层禁用，其余功能不受影响。
- **`MEMORY.md` 是单向投影**：手改无效；深记忆不生成镜像（量太大），要看用 `deep list` / `deep export`。

## License

MIT
