/**
 * extract.ts —— 逐文件语法解析与事实提取。
 *
 * TypeScript compiler API 在这里只被当作「语法解析库」使用：createSourceFile
 * 产出一棵 AST，之后所有判断（sink、源、污点、净化、构造参数）都由本文件
 * 自建的逻辑完成，不启用 ts 的类型检查、不使用任何现成安全规则。
 *
 * 提取产物 FileFact 是纯数据（可 JSON 序列化），AST 在函数返回后即可被回收，
 * 跨文件分析阶段不再接触 AST——这也是增量缓存能只重解析变更文件的基础。
 */
import ts from "typescript";
import fs from "node:fs";
import {
  BINDING_SINK_NAMES,
  ENTITY_SINK_NAMES,
  SANITIZER_NAME_HINTS,
  SOURCE_PATTERNS,
  UPLOAD_READ_CALLS,
} from "./constants.ts";
import type {
  CallFact,
  EventRegFact,
  FileFact,
  FunctionFact,
  ImportSpec,
  ExportSpec,
  OptionFact,
  SinkFact,
  SinkKind,
  TaintToken,
  ValueExpr,
} from "./types.ts";
import { hashFile } from "./workspace.ts";

type Frame = Map<string, TaintToken[]>;
type ParserMarks = Map<string, "dom" | "sax">;

interface ExtractContext {
  file: string;
  sf: ts.SourceFile;
  fact: FileFact;
  inlineSeq: number;
}

function lineCol(ctx: ExtractContext, node: ts.Node): { line: number; column: number } {
  const pos = node.getStart(ctx.sf);
  const lc = ctx.sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression?.(node)
  ) {
    node = (node as any).expression;
  }
  return node;
}

/** 把成员访问/标识符/调用归一成名字链，如 req.file.path -> ["req","file","path"]。 */
export function chainOf(node: ts.Node): string[] {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node))
    return [...chainOf(node.expression), node.name.text];
  if (ts.isElementAccessExpression(node)) {
    const base = chainOf(node.expression);
    if (node.argumentExpression && ts.isStringLiteral(node.argumentExpression))
      return [...base, node.argumentExpression.text];
    return base;
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return chainOf(node.expression);
  return [];
}

function sortedUnion(a: TaintToken[], b: TaintToken[]): TaintToken[] {
  return [...new Set([...a, ...b])].sort();
}

function matchSource(chain: string[]): TaintToken | null {
  for (const p of SOURCE_PATTERNS) {
    if (p.chain.length === chain.length && p.chain.every((s, i) => s === chain[i]))
      return p.label;
  }
  return null;
}

/** 表达式 -> 可序列化值表达式（构造参数/选项对象靠它带到全局阶段折叠）。 */
export function toValue(node: ts.Node | undefined): ValueExpr {
  if (!node) return { t: "unknown", reason: "missing" };
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { t: "lit", value: node.text };
  if (ts.isNumericLiteral(node)) return { t: "lit", value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { t: "lit", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { t: "lit", value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { t: "lit", value: null };
  if (ts.isIdentifier(node)) return { t: "ident", name: node.text };
  if (ts.isPropertyAccessExpression(node))
    return { t: "member", object: toValue(node.expression), property: node.name.text };
  if (ts.isObjectLiteralExpression(node)) {
    return {
      t: "object",
      props: node.properties.map((p): { key: string; value: ValueExpr | undefined } => {
        if (ts.isPropertyAssignment(p)) {
          const key = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
          return { key, value: toValue(p.initializer) };
        }
        if (ts.isShorthandPropertyAssignment(p))
          return { key: p.name.text, value: { t: "ident", name: p.name.text } };
        if (ts.isSpreadAssignment(p)) return { key: "__spread__", value: toValue(p.expression) };
        return { key: p.name?.getText() ?? "?", value: undefined };
      }),
    };
  }
  if (ts.isArrayLiteralExpression(node))
    return { t: "array", items: node.elements.map((e) => toValue(e)) };
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return {
      t: "call",
      calleeChain: chainOf(node.expression),
      args: node.arguments ? node.arguments.map((a) => toValue(a)) : [],
    };
  }
  if (ts.isBinaryExpression(node))
    return { t: "binary", op: ts.SyntaxKind[node.operatorToken.kind], left: toValue(node.left), right: toValue(node.right) };
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    return { t: "unary", op: ts.SyntaxKind[node.operator], operand: toValue((node as any).operand) };
  if (ts.isConditionalExpression(node))
    return {
      t: "conditional",
      test: toValue(node.condition),
      whenTrue: toValue(node.whenTrue),
      whenFalse: toValue(node.whenFalse),
    };
  if (ts.isTemplateExpression(node)) {
    let acc: ValueExpr = { t: "lit", value: node.head.text };
    for (const span of node.templateSpans) {
      acc = { t: "binary", op: "PlusToken", left: acc, right: toValue(span.expression) };
      acc = { t: "binary", op: "PlusToken", left: acc, right: { t: "lit", value: span.literal.text } };
    }
    return acc;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    return { t: "unknown", reason: "function-value" };
  return { t: "unknown", reason: ts.SyntaxKind[node.kind] };
}

class FunctionExtractor {
  private ctx: ExtractContext;
  private func: FunctionFact;
  private frame: Frame = new Map();
  private marks: ParserMarks = new Map();
  private priorSanitizerTaints: TaintToken[] = [];
  private seq = 0;

  constructor(ctx: ExtractContext, func: FunctionFact) {
    this.ctx = ctx;
    this.func = func;
  }

  run(body: ts.Node, params: ts.NodeArray<ts.ParameterDeclaration> | ts.ParameterDeclaration[]): void {
    params.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) this.frame.set(p.name.text, [`p${i}`]);
    });
    this.walkStatements(body);
  }

  private taintOf(node: ts.Node | undefined): TaintToken[] {
    if (!node) return [];
    node = unwrap(node);
    // 源模式：成员链精确匹配三类源。
    const chain = chainOf(node);
    if (chain.length) {
      const src = matchSource(chain);
      if (src) return [src];
    }
    if (ts.isIdentifier(node)) {
      return [...(this.frame.get(node.text) ?? [])].sort();
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = ts.isPropertyAccessExpression(node) ? node.expression : node.expression;
      // 成员访问默认继承接收者污点（chunk.toString()、req.file.stream.on(...) 等）。
      return this.taintOf(obj);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      return this.taintOfCall(node);
    }
    if (ts.isBinaryExpression(node))
      return sortedUnion(this.taintOf(node.left), this.taintOf(node.right));
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      return this.taintOf((node as any).operand);
    if (ts.isConditionalExpression(node))
      return sortedUnion(
        sortedUnion(this.taintOf(node.condition), this.taintOf(node.whenTrue)),
        this.taintOf(node.whenFalse),
      );
    if (ts.isTemplateExpression(node)) {
      let out: TaintToken[] = this.taintOf(node.head as any);
      for (const span of node.templateSpans) out = sortedUnion(out, this.taintOf(span.expression));
      return out;
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.reduce<TaintToken[]>((acc, e) => sortedUnion(acc, this.taintOf(e)), []);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.reduce<TaintToken[]>((acc, p) => {
        if (ts.isPropertyAssignment(p)) return sortedUnion(acc, this.taintOf(p.initializer));
        if (ts.isShorthandPropertyAssignment(p)) return sortedUnion(acc, this.taintOf(p.name));
        if (ts.isSpreadAssignment(p)) return sortedUnion(acc, this.taintOf(p.expression));
        return acc;
      }, []);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return [];
    return [];
  }

  private taintOfCall(node: ts.CallExpression | ts.NewExpression): TaintToken[] {
    const chain = chainOf(node.expression);
    const args = node.arguments ? [...node.arguments] : [];
    const argTaint = args.reduce<TaintToken[]>((acc, a) => sortedUnion(acc, this.taintOf(a)), []);
    const last = chain[chain.length - 1] ?? "";
    // 读上传文件：内容污点跟随路径/流参数的源。
    if (UPLOAD_READ_CALLS.has(last)) return argTaint;
    // 方法调用额外继承接收者污点（x.toString() / stream.pipe(...) 等）。
    if (chain.length > 1) {
      const recv = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : null;
      return sortedUnion(argTaint, recv ? this.taintOf(recv) : []);
    }
    // 自由函数/未知调用：保守地把入参污点传到返回值，跨过程阶段再精确收敛。
    return argTaint;
  }

  private classifySink(node: ts.CallExpression | ts.NewExpression): SinkKind | null {
    const chain = chainOf(node.expression);
    const last = chain[chain.length - 1] ?? "";
    if (ENTITY_SINK_NAMES.has(last)) return "entity";
    if (BINDING_SINK_NAMES.has(last)) return "binding";
    if (last === "parseFromString") return "dom";
    if (last === "parse" && chain.join(".").toLowerCase().includes("xmlparser")) return "binding";
    if (last === "write" && chain.length >= 2) {
      const root = chain[0];
      if (this.marks.get(root) === "sax" || root.toLowerCase().includes("parser")) return "sax";
    }
    return null;
  }

  private xmlArgIndexFor(kind: SinkKind): number {
    return 0;
  }

  private recordSink(node: ts.CallExpression | ts.NewExpression, kind: SinkKind): void {
    const { line, column } = lineCol(this.ctx, node);
    const chain = chainOf(node.expression);
    const args = node.arguments ? [...node.arguments] : [];
    const xmlIdx = this.xmlArgIndexFor(kind);
    const xmlTaint = args[xmlIdx] ? this.taintOf(args[xmlIdx]) : [];
    const options: OptionFact[] = args.map((a, i) => ({ argIndex: i, value: toValue(a) }));
    const guardedBefore = this.priorSanitizerTaints.some((t) => xmlTaint.includes(t));
    const sink: SinkFact = {
      kind,
      line,
      column,
      calleeChain: chain,
      xmlArgIndex: xmlIdx,
      xmlTaint,
      options,
      guardedBefore,
      guardNames: guardedBefore ? this.func.sanitizerCalls.map((s) => s.name) : [],
    };
    this.func.sinks.push(sink);
  }

  private recordParserConstruct(node: ts.CallExpression | ts.NewExpression): void {
    const chain = chainOf(node.expression);
    const args = node.arguments ? [...node.arguments] : [];
    const { line } = lineCol(this.ctx, node);
    this.func.parserConstructs.push({ line, chain, args: args.map((a) => toValue(a)) });
    if (chain[chain.length - 1] === "DOMParser") {
      // new DOMParser() 通常内联；若赋给变量，由变量声明处打标记。
    }
    if (chain.length >= 2 && chain[0] === "sax" && chain[1] === "parser") {
      // 标记由变量声明处理；内联链式使用时靠 root 名兜底。
    }
  }

  private handleCall(node: ts.CallExpression | ts.NewExpression): void {
    const chain = chainOf(node.expression);
    const args = node.arguments ? [...node.arguments] : [];
    const { line, column } = lineCol(this.ctx, node);

    // 解析器构造（new DOMParser / sax.parser）——构造参数从这里追。
    const isConstruct =
      ts.isNewExpression(node) ||
      (chain.length >= 2 && chain[0] === "sax" && chain[1] === "parser") ||
      chain[chain.length - 1] === "DOMParser";
    if (isConstruct) this.recordParserConstruct(node);

    // 事件注册 stream.on("data", cb)：流式回调里的 parser.write 是 SAX sink。
    if (
      ts.isCallExpression(node) &&
      chain.length === 2 &&
      chain[1] === "on" &&
      args.length >= 2 &&
      ts.isStringLiteral(args[0]) &&
      (ts.isArrowFunction(args[1]) || ts.isFunctionExpression(args[1]))
    ) {
      this.handleEventRegistration(node, chain, args as ts.Expression[]);
      return;
    }

    const kind = this.classifySink(node);
    if (kind) this.recordSink(node, kind);

    // 净化原语调用：登记名字与实参污点，供其后的 sink 判 guard。
    const last = chain[chain.length - 1] ?? "";
    if (SANITIZER_NAME_HINTS.includes(last as any)) {
      const argTaint = args.map((a) => this.taintOf(a));
      this.func.sanitizerCalls.push({ line, name: last, argTaint });
      for (const t of argTaint.flat()) this.priorSanitizerTaints.push(t);
    }

    const call: CallFact = {
      line,
      column,
      calleeChain: chain,
      argTaint: args.map((a) => this.taintOf(a)),
      argExprs: args.map((a) => toValue(a)),
      resolvedId: "",
      unresolved: false,
      isEventRegistration: false,
      eventName: null,
      inlineCallbackId: null,
    };
    this.func.calls.push(call);
  }

  private handleEventRegistration(
    node: ts.CallExpression,
    chain: string[],
    args: ts.Expression[],
  ): void {
    const eventName = (args[0] as ts.StringLiteral).text;
    const cb = args[1] as ts.ArrowFunction | ts.FunctionExpression;
    const receiver = (node.expression as ts.PropertyAccessExpression).expression;
    const receiverTaint = this.taintOf(receiver);
    const { line } = lineCol(this.ctx, node);
    const inlineId = `${this.func.name}@inline${++this.seq}`;
    this.ctx.inlineSeq++;

    // data 事件的 chunk 继承流本身的污点——上传流由此进 parser.write。
    const childFrame: Frame = new Map(this.frame);
    const cbParams = cb.parameters ?? [];
    if (eventName === "data" && cbParams[0] && ts.isIdentifier(cbParams[0].name))
      childFrame.set(cbParams[0].name.text, receiverTaint);
    const saved = this.frame;
    this.frame = childFrame;
    const sinkChains: EventRegFact["callbackSinkChains"] = [];
    const prevSinkCount = this.func.sinks.length;
    this.walkNode(cb.body);
    for (const s of this.func.sinks.slice(prevSinkCount))
      sinkChains.push({ chain: s.calleeChain, argTaint: [s.xmlTaint], line: s.line });
    this.frame = saved;

    this.func.events.push({
      line,
      eventName,
      receiverTaint,
      inlineCallbackId: inlineId,
      callbackSinkChains: sinkChains,
    });
    this.func.calls.push({
      line,
      column: lineCol(this.ctx, node).column,
      calleeChain: chain,
      argTaint: [receiverTaint, []],
      argExprs: args.map((a) => toValue(a)),
      resolvedId: "",
      unresolved: false,
      isEventRegistration: true,
      eventName,
      inlineCallbackId: inlineId,
    });
  }

  private walkStatements(body: ts.Node): void {
    if (ts.isBlock(body)) {
      for (const st of body.statements) this.walkStatement(st);
    } else {
      this.walkNode(body);
    }
  }

  private walkStatement(st: ts.Statement): void {
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) this.handleVarDecl(decl);
      return;
    }
    if (ts.isReturnStatement(st)) {
      this.func.returns.push({ line: lineCol(this.ctx, st).line, taint: this.taintOf(st.expression) });
      if (st.expression) this.walkNode(st.expression);
      return;
    }
    if (ts.isExpressionStatement(st)) {
      this.walkNode(st.expression);
      return;
    }
    if (ts.isIfStatement(st)) {
      this.walkNode(st.expression);
      this.walkStatement(st.thenStatement);
      if (st.elseStatement) this.walkStatement(st.elseStatement);
      return;
    }
    if (ts.isBlock(st)) return this.walkStatements(st);
    this.walkNode(st);
  }

  private handleVarDecl(decl: ts.VariableDeclaration): void {
    if (!ts.isIdentifier(decl.name) || !decl.initializer) {
      if (decl.initializer) this.walkNode(decl.initializer);
      return;
  }
    const name = decl.name.text;
    const init = unwrap(decl.initializer);
    // 记录解析器变量标记，供 parser.write 归类 SAX。
    const initChain = ts.isCallExpression(init) || ts.isNewExpression(init) ? chainOf(init.expression) : [];
    if (initChain.length >= 2 && initChain[0] === "sax" && initChain[1] === "parser")
      this.marks.set(name, "sax");
    if (initChain[initChain.length - 1] === "DOMParser") this.marks.set(name, "dom");
    this.frame.set(name, this.taintOf(init));
    // 函数值不进配置折叠；其余初值登记为局部常量，供工厂/选项间接传参折叠。
    if (!(ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
      this.func.localValues[name] = toValue(init);
    this.walkNode(decl.initializer);
  }

  private walkNode(node: ts.Node): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      this.handleCall(node);
      // 链式调用：callee 本身是调用/new 表达式（如 parser.write(xml).close()、
      // new DOMParser(opts).parseFromString(...)），内层的 write/构造器才是 sink/配置来源，
      // 必须走进去，否则会漏报或漏掉构造参数。
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (ts.isCallExpression(node.expression.expression) ||
          ts.isNewExpression(node.expression.expression))
      ) {
        this.walkNode(node.expression.expression);
      }
      // 继续走进参数（回调内联函数也在参数里，事件注册已单独处理并消费回调）。
      if (node.arguments) {
        for (const a of node.arguments) {
          const isConsumedCallback =
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "on";
          if (!isConsumedCallback) this.walkNode(a);
        }
      }
      if (ts.isNewExpression(node) && node.expression) this.walkNode(node.expression);
      return;
    }
    if (ts.isVariableDeclaration(node)) return this.handleVarDecl(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // 非事件回调的内联函数（如 map/filter 回调）：在子帧里走一遍，参数无外源。
      const saved = this.frame;
      const child: Frame = new Map(this.frame);
      (node.parameters ?? []).forEach((p, i) => {
        if (ts.isIdentifier(p.name)) child.set(p.name.text, [`p${i}`]);
      });
      this.frame = child;
      this.walkStatements(node.body);
      this.frame = saved;
      return;
    }
    ts.forEachChild(node, (c) => this.walkNode(c));
  }
}

export function parseFile(absPath: string, relPath: string): FileFact {
  const text = fs.readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const ctx: ExtractContext = { file: relPath, sf, fact: newEmptyFact(relPath, text), inlineSeq: 0 };

  // createSourceFile 产出的语法诊断挂在内部字段 parseDiagnostics 上（类型定义未暴露）。
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const diag of diags) {
    const lc = sf.getLineAndCharacterOfPosition(diag.start ?? 0);
    ctx.fact.syntaxErrors.push({
      line: lc.line + 1,
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
    });
  }

  sf.forEachChild((node) => visitTopLevel(ctx, node));
  ctx.fact.lineCount = text.split(/\r\n|\r|\n/).length;
  ctx.fact.sha256 = hashFile(absPath);
  return ctx.fact;
}

function newEmptyFact(file: string, text: string): FileFact {
  return {
    path: file,
    sha256: "",
    lineCount: text.split(/\r\n|\r|\n/).length,
    imports: [],
    exports: [],
    functions: {},
    topLevelValues: {},
    syntaxErrors: [],
  };
}

function visitTopLevel(ctx: ExtractContext, node: ts.Node): void {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    collectImport(ctx, node);
    return;
  }
  if (ts.isExportDeclaration(node)) {
    const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : null;
    if (!node.exportClause) {
      ctx.fact.exports.push({ exportName: "*", localName: "*", moduleSpecifier: spec });
    } else if (ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        ctx.fact.exports.push({
          exportName: el.name.text,
          localName: el.propertyName ? el.propertyName.text : el.name.text,
          moduleSpecifier: spec,
        });
      }
    }
    return;
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    const name = node.name.text;
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      ctx.fact.exports.push({ exportName: name, localName: name, moduleSpecifier: null });
    extractFunction(ctx, name, node.parameters, node.body ?? node);
    return;
  }
  if (ts.isVariableStatement(node)) {
    const isExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const name = decl.name.text;
      if (isExport) ctx.fact.exports.push({ exportName: name, localName: name, moduleSpecifier: null });
      const init = unwrap(decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        extractFunction(ctx, name, init.parameters ?? [], init.body);
      } else {
        ctx.fact.topLevelValues[name] = toValue(init);
      }
    }
    return;
  }
  if (ts.isExportAssignment(node)) {
    ctx.fact.exports.push({ exportName: "default", localName: "default", moduleSpecifier: null });
    return;
  }
  // require(...) 形式的 CommonJS 依赖。
  if (ts.isVariableStatement(node)) return;
  ts.forEachChild(node, (c) => visitTopLevel(ctx, c));
}

function collectImport(ctx: ExtractContext, node: ts.ImportDeclaration): void {
  const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
  const clause = node.importClause;
  if (!clause) return;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    const spec: ImportSpec = {
      localName: clause.namedBindings.name.text,
      importedName: "*",
      moduleSpecifier: specifier,
      isNamespace: true,
    };
    ctx.fact.imports.push(spec);
    return;
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const el of clause.namedBindings.elements) {
      ctx.fact.imports.push({
        localName: el.name.text,
        importedName: el.propertyName ? el.propertyName.text : el.name.text,
        moduleSpecifier: specifier,
        isNamespace: false,
      });
    }
  }
  if (clause.name) {
    ctx.fact.imports.push({
      localName: clause.name.text,
      importedName: "default",
      moduleSpecifier: specifier,
      isNamespace: false,
    });
  }
}

function extractFunction(
  ctx: ExtractContext,
  name: string,
  params: ts.NodeArray<ts.ParameterDeclaration> | ts.ParameterDeclaration[],
  body: ts.Node,
): void {
  const id = `${ctx.file}#${name}`;
  const lc = ctx.sf.getLineAndCharacterOfPosition(body.getStart(ctx.sf));
  const fact: FunctionFact = {
    id,
    name,
    file: ctx.file,
    line: lc.line + 1,
    paramNames: params
      .map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""))
      .filter(Boolean),
    sinks: [],
    calls: [],
    events: [],
    returns: [],
    sanitizerCalls: [],
    parserConstructs: [],
    localValues: {},
  };
  new FunctionExtractor(ctx, fact).run(body, params);
  ctx.fact.functions[id] = fact;
}
