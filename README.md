# 文档转换服务 · JS/TS XXE 静态分析语料

题面把检测做在前面：文档转换服务收到的 XML 默认允许外部实体，静态分析器要找出
「外部 XML 从哪来 → 经过哪些模块 → 在哪个解析器落点被展开」的链路。这个仓库是
**语料 + baseline**，不是成品分析器。

## 语料布局（三包 monorepo）

| 路径 | 作用 |
|---|---|
| `packages/common-config` | 公共配置：`defaultConfig` 默认 `allowDtd=true`、`resolveExternalEntities=true`；`assertNoDoctype` 是净化原语 |
| `packages/parser-wrapper` | 解析器封装：DOM / SAX / xml2js 绑定 / 自定义实体展开四类落点，共 50 个 sink 函数 |
| `packages/doc-service` | 文档服务：上传文件、URL 参数、消息体三条源，经 workspace 依赖 `@doc/parser-wrapper` 进入 sink |
| 无运行时依赖 | 语料只做静态分析，不需要 `npm install`，也不需要起服务 |

`package.json` 的 `workspaces` 只有 `packages/*`，三包互引用走真实 workspace 依赖
（`@doc/parser-wrapper`、`@doc/common-config`），可用于验证 monorepo 路径解析。

## 口径

- **落点（4 类）**：DOM 解析器 `parseFromString`、SAX 解析器 `parser.write`、
  XML 绑定反序列化 `parseString` / `xmlParser.parse`、自定义实体展开 `expandEntities`。
- **源（3 类）**：上传文件（`fs.readFileSync(req.file.path)` / `req.file.stream`）、
  URL 参数（`req.query.xml` / `req.query.doc`）、消息体（`msg.body`）。
- **传播**：`doc-service` 的 handler 把源交给 `parser-wrapper` 的函数；SAX 还包含
  `Readable.on("data", chunk => parser.write(chunk))` 的流式回调，绑定用 `done` 回调。
- **净化**：解析前 `assertNoDoctype(xml)`，或构造参数 `allowDtd=false` /
  `resolveExternalEntities=false` / `expandEntities=false`。`parser-wrapper/src/secure.ts`
  的 22 个函数是净化后的 decoy，baseline 会全部误报。

## 跑法

```powershell
python baseline/scan.py > findings.json
python baseline/scan.py --sarif findings.sarif
python eval.py findings.json
python -m pytest tests -q
```

## 当前 baseline（正则）

`baseline/scan.py` 只按行匹配 XML 解析/实体展开关键字，不做 AST、不看配置、不跟跨模块。
在 50 条标注样本上的实测：

- 召回 **100.0%**，误报率 **31.5%**（labels=50，findings=73）
- 误报全部来自 `packages/parser-wrapper/src/secure.ts` 的 22 个 decoy，以及
  `expandEntities` 的函数定义行——baseline 分不清「同一个 sink + 已禁用 DTD」。

这正是题目要求改进的起点：要自建 AST 与符号表，追配置项与解析器构造参数，
把「同一 sink 的净化写法」和真漏洞分开。

## labels.json

`vulns` 共 50 条，每条给出 `file`、`line`、`sink`、`entry`、`source`；行号是仓库里
真实的行，`tests/test_corpus.py::test_fifty_labels_point_at_real_sink_lines` 会逐条断言
该行确实含 sink 调用，防止语料改动后行号漂移。

## 确定性

`baseline/scan.py --sarif` 不写时间戳，规则序、文件序、结果序全部排序后输出；
`test_sarif_is_byte_identical_across_runs` 连扫两次断言逐字节一致。
