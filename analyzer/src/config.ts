/**
 * config.ts —— 配置项与解析器构造参数的静态追踪。
 *
 * 追法（三层，全部在自建的 ValueExpr 符号模型上做，不跑类型检查）：
 *
 * 1. 字面量层：sink 调用/构造器的参数若是对象字面量
 *    （new DOMParser({ allowDtd:false })、parseString(xml,{...})），直接读键。
 * 2. 常量折叠层：参数是标识符时，经 GlobalIndex 取顶层变量的初值——
 *    支持 secureConfig = loadConfig({ allowDtd:false }) 这类工厂合并
 *    （展开对象展开符、按序合并 overrides），也能跨 import 追到 common-config。
 * 3. 形参替换层：构造参数经工厂函数间接传入时，跨过程把实参 ValueExpr
 *    替换形参（paramValues，深度受 MAX_SUMMARY_DEPTH 限制）；替换链断在
 *    动态值/外部输入上时，结论是 unknown，由 analyze 计入未决清单，绝不猜安全。
 */
import { SECURE_CONFIG_KEYS } from "./constants.ts";
import type { FunctionFact, SinkFact, ValueExpr } from "./types.ts";
import type { GlobalIndex } from "./symbols.ts";
import { MAX_SUMMARY_DEPTH } from "./constants.ts";

export interface FoldCtx {
  file: string;
  index: GlobalIndex;
  depth: number;
  /** 形参 token -> 调用方实参 ValueExpr（工厂间接传参的替换表）。 */
  paramValues: Map<string, ValueExpr>;
  /** 当前函数体内的局部常量（const cfg = ...），名 -> 初值。 */
  locals: Map<string, ValueExpr>;
}

type Const = string | number | boolean | null | Const[] | { [k: string]: Const };
const UNKNOWN = Symbol("config-unknown");

export function isUnknown(v: Const | symbol): boolean {
  return v === UNKNOWN;
}

/** 把 ValueExpr 折叠成常量；任何一环追不出来就返回 UNKNOWN（不猜）。 */
export function fold(expr: ValueExpr | undefined, ctx: FoldCtx): Const | symbol {
  if (!expr || ctx.depth > MAX_SUMMARY_DEPTH) return UNKNOWN;
  switch (expr.t) {
    case "lit":
      return expr.value;
    case "ident": {
      const viaParam = ctx.paramValues.get(`ident:${expr.name}`) ?? ctx.paramValues.get(expr.name);
      if (viaParam) return fold(viaParam, { ...ctx, depth: ctx.depth + 1 });
      const local = ctx.locals.get(expr.name);
      if (local) return fold(local, { ...ctx, depth: ctx.depth + 1 });
      const top = ctx.index.getTopLevelValue(ctx.file, expr.name);
      if (top) return fold(top, { ...ctx, depth: ctx.depth + 1 });
      // 函数形参（pN 形式由调用方替换；裸 ident 形参在此判未知）。
      return UNKNOWN;
    }
    case "member": {
      const obj = fold(expr.object, ctx);
      if (obj === UNKNOWN || typeof obj !== "object" || obj === null || Array.isArray(obj))
        return UNKNOWN;
      const v = (obj as Record<string, Const>)[expr.property];
      return v === undefined ? UNKNOWN : v;
    }
    case "object": {
      const out: Record<string, Const> = {};
      for (const prop of expr.props) {
        if (prop.key === "__spread__") {
          const spread = fold(prop.value, { ...ctx, depth: ctx.depth + 1 });
          if (spread === UNKNOWN || typeof spread !== "object" || spread === null) return UNKNOWN;
          Object.assign(out, spread);
        } else {
          const v = fold(prop.value, { ...ctx, depth: ctx.depth + 1 });
          if (v === UNKNOWN) return UNKNOWN;
          out[prop.key] = v as Const;
        }
      }
      return out;
    }
    case "array": {
      const items: Const[] = [];
      for (const it of expr.items) {
        const v = fold(it, ctx);
        if (v === UNKNOWN) return UNKNOWN;
        items.push(v as Const);
      }
      return items;
    }
    case "spread":
      return fold(expr.arg, ctx);
    case "call": {
      // 工厂合并：loadConfig(overrides) / Object.assign(base, ...) / mergeConfig。
      const callee = expr.calleeChain[expr.calleeChain.length - 1] ?? "";
      if (callee === "loadConfig" || callee === "mergeConfig" || callee === "assign") {
        let merged: Record<string, Const> = {};
        let failed = false;
        for (const a of expr.args) {
          const v = fold(a, { ...ctx, depth: ctx.depth + 1 });
          if (v === UNKNOWN || typeof v !== "object" || v === null || Array.isArray(v)) {
            failed = true;
            break;
          }
          Object.assign(merged, v);
        }
        return failed ? UNKNOWN : merged;
      }
      return UNKNOWN;
    }
    case "binary": {
      const l = fold(expr.left, ctx);
      const r = fold(expr.right, ctx);
      if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
      switch (expr.op) {
        case "EqualsEqualsToken":
        case "EqualsEqualsEqualsToken":
          return l === r;
        case "ExclamationEqualsToken":
        case "ExclamationEqualsEqualsToken":
          return l !== r;
        case "AmpersandAmpersandToken":
          return Boolean(l) && Boolean(r);
        case "BarBarToken":
          return Boolean(l) || Boolean(r);
        case "PlusToken":
          return (l as any) + (r as any);
        default:
          return UNKNOWN;
      }
    }
    case "unary": {
      const v = fold(expr.operand, ctx);
      if (v === UNKNOWN) return UNKNOWN;
      if (expr.op === "ExclamationToken") return !v;
      return UNKNOWN;
    }
    case "conditional": {
      const test = fold(expr.test, ctx);
      if (test === UNKNOWN) return UNKNOWN;
      return fold(test ? expr.whenTrue : expr.whenFalse, ctx);
    }
    default:
      return UNKNOWN;
  }
}

type Verdict = "safe" | "open" | "unknown";

/** 从一个折叠后的对象里读安全键；显式 false 即关闭，显式 true 即打开。 */
function flagsOf(obj: Const | symbol): Map<string, Verdict> {
  const flags = new Map<string, Verdict>();
  if (obj === UNKNOWN || typeof obj !== "object" || obj === null) return flags;
  const rec = obj as Record<string, Const>;
  for (const key of SECURE_CONFIG_KEYS) {
    if (!(key in rec)) continue;
    const v = rec[key];
    flags.set(key, v === false ? "safe" : v === true ? "open" : "unknown");
  }
  return flags;
}

function mergeFlags(into: Map<string, Verdict>, add: Map<string, Verdict>): void {
  for (const [k, v] of add) {
    const prev = into.get(k);
    // 同一键多处出现：只要有一处 safe（显式关闭）即视为关闭，否则取最弱者。
    if (v === "safe") into.set(k, "safe");
    else if (prev === undefined) into.set(k, v);
    else if (prev === "safe") into.set(k, "safe");
    else into.set(k, prev === "open" || v === "open" ? "open" : "unknown");
  }
}

/** 配置判定结果：verdict + 是否存在「提到安全键却折叠不出来」的表达式。 */
export interface ConfigDecision {
  verdict: Verdict;
  /** 有安全键相关配置，但经工厂/标识符间接传入且常量折叠断裂——真未知。 */
  hasUnresolvableSecurityKey: boolean;
}

/** 递归判断 ValueExpr 是否静态提到任一安全配置键（含嵌套/展开/三元）。 */
export function exprMentionsSecurityKey(expr: ValueExpr | undefined): boolean {
  if (!expr || typeof expr !== "object") return false;
  switch (expr.t) {
    case "object":
      return expr.props.some(
        (p) =>
          (SECURE_CONFIG_KEYS as readonly string[]).includes(p.key) ||
          exprMentionsSecurityKey(p.value),
      );
    // 标识符/成员/工厂调用本身不直接含键名；只有当它能折叠出含安全键的对象时才算。
    // 是否真未知交给 fold 结果 + keyReached 标记，而不是凭表达式形态猜测。
    case "array":
      return expr.items.some(exprMentionsSecurityKey);
    case "binary":
      return exprMentionsSecurityKey(expr.left) || exprMentionsSecurityKey(expr.right);
    default:
      return false;
  }
}

/**
 * 判定一个 sink 的构造/选项参数是否关闭了 DTD/外部实体。
 * 同时检查 sink 调用参数与同函数内的解析器构造器（new DOMParser / sax.parser）。
 */
export function sinkConfigDecision(
  sink: SinkFact,
  fn: FunctionFact,
  baseCtx: FoldCtx,
): ConfigDecision {
  const flags = new Map<string, Verdict>();
  let hasUnresolvableSecurityKey = false;

  /** 折叠后检查对象里是否出现安全键；出现但值追不出来才是真未知。 */
  const consider = (expr: ValueExpr, isTrailingArg: boolean): void => {
    const mentions = exprMentionsSecurityKey(expr);
    const folded = fold(expr, baseCtx);
    const before = flags.size;
    mergeFlags(flags, flagsOf(folded));
    if (mentions && folded === UNKNOWN) hasUnresolvableSecurityKey = true;
    // 表达式提到安全键、折叠成功却没读出任何键（极端覆盖情况）也按真未知保守处理。
    if (mentions && folded !== UNKNOWN && flags.size === before)
      hasUnresolvableSecurityKey = true;
    // 裸标识符折叠断裂：尾部回调（done/cb/...）忽略；其余按「间接传入、追不出的配置」记未知。
    if (expr.t === "ident" && folded === UNKNOWN && !mentions) {
      const isCallback = isTrailingArg && thisLooksLikeCallback(expr.name, fn);
      if (!isCallback) hasUnresolvableSecurityKey = true;
    }
  };

  // 1) sink 的配置参数：XML 实参之外的选项位；尾参且为 Node 风格回调名的（done）忽略。
  const optionOpts = sink.options.filter((o) => o.argIndex !== sink.xmlArgIndex);
  const maxArg = optionOpts.reduce((m, o) => Math.max(m, o.argIndex), -1);
  for (const opt of optionOpts) consider(opt.value, opt.argIndex === maxArg);

  // 2) 同函数体内的解析器构造参数（DOMParser 构造器、sax.parser 第二参）。
  for (const c of fn.parserConstructs) {
    c.args.forEach((arg, i) => consider(arg, i === c.args.length - 1));
  }

  let verdict: Verdict;
  if ([...flags.values()].includes("safe")) verdict = "safe";
  else if (flags.size === 0) verdict = "unknown";
  else if ([...flags.values()].every((v) => v === "open")) verdict = "open";
  else verdict = "unknown";

  // 没有任何安全键被显式触达：解析器在 DTD 维度走默认值，按 open 处理而非未知。
  if (verdict === "unknown" && !hasUnresolvableSecurityKey) verdict = "open";
  return { verdict, hasUnresolvableSecurityKey };
}

/** 标识符是否是 Node 风格尾回调（done/cb/next/callback 等），避免把回调误当配置对象。 */
function thisLooksLikeCallback(name: string, fn: FunctionFact): boolean {
  void fn;
  const lower = name.toLowerCase();
  return /^(done|cb|callback|next|on\w+|handler|fn|func)$/.test(lower);
}

/** 工厂间接传参：把 callee 形参 token 映射到 caller 实参 ValueExpr。 */
export function buildParamValues(
  paramNames: string[],
  argExprs: ValueExpr[],
): Map<string, ValueExpr> {
  const map = new Map<string, ValueExpr>();
  paramNames.forEach((name, i) => {
    if (argExprs[i] === undefined) return;
    map.set(`p${i}`, argExprs[i]);
    map.set(`ident:${name}`, argExprs[i]);
  });
  return map;
}
