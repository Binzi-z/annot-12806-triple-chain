# JS/TS XXE 静态分析器

只用 **TypeScript compiler API 当语法解析库**（`ts.createSourceFile` 产出 AST），
AST 之上的符号表、模块解析、调用图、污点传播、配置常量折叠全部自建，
**不套用任何现成安全规则包**。目标是在文档转换服务里把
「外部 XML 从哪来 → 经过哪些模块 → 在哪个解析器落点被展开 → 有没有被净化」这条链静态求出来。

## 1. 流水线总览

```
discoverRepo (workspace.ts)
   读根/各包 package.json，把 workspaces 的 "packages/*" 与 workspace:* 依赖
   解析成磁盘真实文件，得到参与分析的有序文件列表
        │
parseFile (extract.ts)   —— 每文件独立，唯一接触 AST 的阶段
   ts.createSourceFile 语法解析 → 自建 FileFact：
   函数事实（sink/调用/事件回调/返回/净化调用/解析器构造/局部常量）、
   import/export、顶层常量值、语法诊断。产物是纯数据，AST 用完即弃
        │
GlobalIndex (symbols.ts) —— 跨文件符号表
   扁平导出表（barrel 的 export * 只合并一次）、workspace 真实路径解析、
   调用链 → 函数 id / 外部库 / 未知
        │
Analyzer (analyze.ts)
   调用图（带边数上界）→ 迭代不动点求每函数可达 sink 汇总 →
   从三类源驱动污点 → 净化/配置判定 → findings + 未决清单
        │
sarif.ts / cli.ts
   确定性 SARIF 2.1.0 / JSON，CI 按基线阻断新增
```

模块职责与文件：

| 文件 | 职责 |
|---|---|
| `workspace.ts` | monorepo 发现、workspace 依赖真实路径解析、文件枚举、sha256 |
| `extract.ts` | 语法解析（唯一用 ts API 处）、局部污点求值、sink/源/净化/构造识别、ValueExpr 提取 |
| `symbols.ts` | 扁平导出表、import 绑定、调用目标解析、顶层常量跨文件取值 |
| `config.ts` | ValueExpr 常量折叠、配置项/构造参数三态判定（safe/open/unknown） |
| `analyze.ts` | 调用图（上界）、不动点跨过程汇总、源→sink 污点、净化抑制、未决清单 |
| `cache.ts` | 单文件 FileFact 增量缓存（按 sha256） |
| `sarif.ts` | 确定性 SARIF/JSON 输出 |
| `cli.ts` | 命令行、全量/增量、CI 基线阻断 |

## 2. 检测口径

- **落点（4 类，规则 id 与 labels.json 对齐）**
  - DOM：`new DOMParser(...).parseFromString(xml, ...)` → `XXE-DOM-001`
  - SAX：`sax.parser(...)` 之后的 `parser.write(xml)`，含
    `stream.on("data", chunk => parser.write(chunk.toString()))` 流式回调 → `XXE-SAX-002`
  - XML 绑定反序列化：`parseString` / `parseStringPromise` / `parseXml` / `xmlParser.parse` → `XXE-BIND-003`
  - 自定义实体展开：`expandEntities` / `resolveEntity` 等 → `XXE-ENTITY-004`
- **源（3 类）**：上传文件（`req.file.path`/`req.file.stream`，含 `fs.readFileSync`）、
  URL 参数（`req.query.xml`/`req.query.doc`）、消息体（`msg.body`）。
- **传播**：函数实参→形参的 token 映射跨模块、跨包；内联回调（含流式 `data`、绑定 `done`）单独建帧。
- **净化（满足任一即抑制该 sink）**
  - 解析前对同一污点调用 `assertNoDoctype` 等净化原语（按名 + 污点同一性）；
  - 构造参数/选项里显式 `allowDtd:false` / `resolveExternalEntities:false` /
    `expandEntities:false` / `disableEntities` / `noent:false`。

## 3. 配置项与解析器构造参数在静态分析里怎么追（重点）

所有表达式先被归一成可序列化的 `ValueExpr`（字面量/标识符/成员/对象/数组/调用/展开/三元/二进制），
再由 `config.ts` 在三个层级上做**常量折叠**，结论是三态而不是布尔：

1. **字面量层**：sink 调用或构造器的参数是对象字面量
   （`new DOMParser({ allowDtd:false })`、`parseString(xml, {...}, done)`），直接读安全键。
2. **常量折叠层**：参数是标识符时，经符号表取它的初值——
   - 函数内局部常量（`const cfg = ...`）；
   - 顶层常量，且能跨 `import` 追到别的包（如 `common-config` 的 `secureConfig`）；
   - 工厂合并：识别 `loadConfig(overrides)` / `Object.assign` / `mergeConfig`，
     展开对象展开符 `{ ...defaultConfig, ...overrides }` 并按序合并，
     因此 `loadConfig({ allowDtd:false })` 能折叠出 `allowDtd:false`。
3. **形参替换层（工厂间接传参）**：构造参数经工厂函数多层间接传入时，
   跨过程把调用方实参 `ValueExpr` 替换被调函数形参（`paramValues`），深度受 `MAX_SUMMARY_DEPTH` 限制。

判定规则（`sinkConfigDecision`）：

- 折叠出任一安全键为 `false` → **safe**，抑制；
- 安全键全部显式 `true`，或**没有任何安全键配置（解析器裸用默认值）** → **open**，报漏洞
  （这正是事故根因：默认 `allowDtd=true`）；
- 表达式确实触达安全键、但折叠链断在动态值/外部输入上（如 `new DOMParser(options)`，
  `options` 是追不到来源的形参）→ **unknown**，**不猜安全**，计入未决清单 `unknown-config`。

为降低误报，尾部 Node 风格回调（`done`/`cb`/`callback`/`next` 等）不会被当成配置对象；
`{ explicitArray:false }` 这类与 DTD 无关的普通选项不影响判定，解析器在 DTD 维度仍按默认 `open`。

## 4. 跨仓库 / monorepo 解析

- 只信 `package.json`：根 `workspaces`（数组或 `{packages:[]}` 两种写法）+ 每包 `name/main/types/exports`。
- bare specifier 按 workspace 包名解析到真实入口，支持 `@doc/pkg/sub/path` 子路径、
  `export *` barrel、`export { x } from "./mod"`、相对路径与扩展名/`index` 回退。
- 三个包（parser-wrapper / doc-service / common-config）在**同一个全局索引**里一起分析，
  外部库（`@xmldom/xmldom`、`sax`、`xml2js`、`fast-xml-parser` 等）标记为 external，由 sink 模型覆盖。
- barrel 的 `export *` 预聚合成**扁平导出表**：600 个 star 只合并一次，
  之后每次导入查询 O(1)，不会随「名字数 × star 数」平方膨胀。

## 5. 调用图、边数上界与未决清单

- **边数上界**：`MAX_CALL_EDGES`（默认 200000，可用 `XXE_MAX_EDGES` 覆盖）。
  每解析出一条函数间调用边计数；触顶后剩余调用不再展开，置 `unresolved` 并登记 `edge-cap` 未决。
  SARIF 的 `run.properties` 里回传 `callEdges / callEdgeCap / callEdgeCapReached`。
- **跨过程汇总用迭代不动点（worklist），不用递归 DFS**：
  反向边把 callee 的可达 sink 回传给 caller，每条边做形参→实参污点翻译，
  按「sink 坐标 + 污点/guard 集合」稳定键去重；自环/递归翻译出的等价 sink 命中同一键被丢弃，
  环靠「无新增即收敛」终止，跳数 `MAX_SUMMARY_DEPTH` 仅作兜底。
  worklist 用头指针队列，避免 `Array.shift()` 的 O(n) 退化。
- **未决清单（pending）**：确定不了的不武断下结论，分类记账——
  `unresolved-callee`（项目内自由函数解析不出）、`unknown-config`（构造参数间接传入折叠断裂）、
  `unresolved-import`、`syntax-error`、`edge-cap`、`taint-unknown`。
  外部库调用、JS 全局（`String`/`Error`/`Promise`）、回调形参不进未决。

## 6. 确定性

- SARIF/JSON **不写任何时间戳/进程 id/随机数**（刻意省略 `startTimeUtc/endTimeUtc`，`durationMs` 只进控制台）。
- 规则固定 4 条按 `ruleId` 排序；results 按 `(uri,line,column,ruleId)` 排序；
  对象按固定键序构造，`JSON.stringify(..., 2)` + LF + 末尾单换行。
- 同一批输入连扫两次输出**逐字节相同**（测试 `SARIF 连扫两次逐字节一致` 钉死）。

## 7. 用法与 CI 阻断

```bash
# 全量，产出 SARIF 与 JSON
node analyzer/src/cli.ts --root . --sarif findings.sarif --json findings.json

# 增量：只重解析变更文件（其余按 sha256 走缓存），全局分析照常
node analyzer/src/cli.ts --root . --files packages/doc-service/src/upload.ts --sarif inc.sarif

# CI 阻断新增：与历史基线比，新增 finding 数 > --max-new 即退出码 1
node analyzer/src/cli.ts --root . --sarif cur.sarif --baseline base.sarif --max-new 0
```

退出码：0 通过；1 新增超阈值（CI 阻断）；2 根目录不存在。

## 8. 验收结果

在随仓库 50 条标注样本上（`eval.py`，file+line 口径）：

| 指标 | 要求 | 实测 |
|---|---|---|
| 召回 | ≥85% | **100%（50/50）** |
| 误报率 | ≤15% | **0%（secure.ts 的 22 个净化 decoy 全抑制）** |
| 全量 20 万行 | <3 分钟 | **约 10.7s（19.7 万行合成 monorepo，冷缓存）** |
| 增量 | <15s | **约 6.1s，parsed=1（仅重解析变更文件）** |
| 确定性 | 连扫两次逐字节一致 | 通过（无时间戳） |

合成压测仓库由 `perf-gen.mjs` 生成（`PERF_N/PERF_F` 调规模），`perf-bench.mjs` 一键复现上表。

## 9. 测试

```bash
npm --prefix analyzer run typecheck     # tsc --noEmit
node --test analyzer/test/              # 23 个用例：语料验收/配置追踪/调用图上界/增量缓存/CI 阻断
```

测试覆盖：内联 false、跨文件 `secureConfig`、`loadConfig` 工厂合并、间接传参标 unknown、
`assertNoDoctype` 净化、默认配置报漏洞、SAX 流式回调、尾回调不误判、边数触顶、
递归环终止、未解析 callee 记账、缓存哈希失效、CI 退出码、SARIF 确定性等。
