"use strict";

/**
 * Интерпретатор правил доступа Firestore (saas/firestore.rules) — для
 * собственного сервера данных: права проверяются по тому же файлу правил,
 * что и в Firebase, и тем же набором тестов (saas/test/firestore.rules.test.js).
 *
 * Поддерживается то, что используют наши правила: match с переменными и
 * {rest=**}, вложенные match, функции с let, allow для read/get/list/write/
 * create/update/delete, get()/exists() по пути с $(...), request.auth,
 * request.resource.data, resource.data, request.time, duration.value,
 * timestamp.value, операторы (&& || ! == != < <= > >= in + - * / % ?:),
 * is-проверки типов, методы карт (keys, values, size, get, diff →
 * affectedKeys/changedKeys/addedKeys/removedKeys/unchangedKeys), списков и
 * множеств (size, hasOnly, hasAny, hasAll, join, toSet, [i]), строк (size,
 * matches, replace, lower, upper, trim, split).
 *
 * Ошибки (нет поля, null.data) — как в Firestore: правило не разрешает, но
 * «ошибка || true» = true, «false && ошибка» = false.
 */

// ------------------------------------------------------------ значения

class RTime {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
}
class RDur {
  constructor(ms) { this.ms = ms; }
}
class RSet {
  constructor(items) { this.items = items; }
}
class RulesError extends Error {}

const fail = (msg) => { throw new RulesError(msg); };
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof RTime) && !(v instanceof RDur) && !(v instanceof RSet) && !(v instanceof RPath);
class RPath {
  constructor(s) { this.s = s; }
}

/** Значение из хранилища → значение правил: метки времени → RTime. */
function fromData(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof RTime) return v;
  if (typeof v.toMillis === "function") return new RTime(v.toMillis());
  if (v instanceof Date) return new RTime(v.getTime());
  if (Array.isArray(v)) return v.map(fromData);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === "__ts" && typeof v.__ts === "number") return new RTime(v.__ts);
  const out = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = fromData(x);
  return out;
}

function equal(a, b) {
  if (a instanceof RTime && b instanceof RTime) return a.ms === b.ms;
  if (a instanceof RDur && b instanceof RDur) return a.ms === b.ms;
  if (a instanceof RSet || b instanceof RSet) {
    const x = a instanceof RSet ? a.items : a;
    const y = b instanceof RSet ? b.items : b;
    if (!Array.isArray(x) || !Array.isArray(y)) return false;
    return x.length === y.length && x.every((i) => y.some((j) => equal(i, j)));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && equal(a[k], b[k]));
  }
  return a === b;
}

function compare(a, b) {
  if (a instanceof RTime && b instanceof RTime) return a.ms - b.ms;
  if (a instanceof RDur && b instanceof RDur) return a.ms - b.ms;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return fail(`нельзя сравнить ${typeName(a)} и ${typeName(b)}`);
}

function typeName(v) {
  if (v === null) return "null";
  if (v instanceof RTime) return "timestamp";
  if (v instanceof RDur) return "duration";
  if (v instanceof RSet) return "set";
  if (v instanceof RPath) return "path";
  if (Array.isArray(v)) return "list";
  if (isMap(v)) return "map";
  return typeof v;
}

function isType(v, t) {
  switch (t) {
    case "string": return typeof v === "string";
    case "int": return typeof v === "number" && Number.isInteger(v);
    case "float": return typeof v === "number" && !Number.isInteger(v);
    case "number": return typeof v === "number";
    case "bool": return typeof v === "boolean";
    case "map": return isMap(v);
    case "list": return Array.isArray(v);
    case "timestamp": return v instanceof RTime;
    case "duration": return v instanceof RDur;
    case "path": return v instanceof RPath;
    case "set": return v instanceof RSet;
    case "null": return v === null;
    default: return fail(`неизвестный тип ${t}`);
  }
}

const UNITS = { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, ns: 1e-6 };

// ------------------------------------------------------------ разбор

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2); if (i < 0) i = n; else i += 2; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      toks.push({ t: "num", v: Number(raw), at: i });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") {
          const e = src[j + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else s += src[j++];
      }
      toks.push({ t: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { toks.push({ t: "op", v: two, at: i }); i += 2; continue; }
    if ("{}()[];,.:=<>!+-*/%?$".includes(c)) { toks.push({ t: "op", v: c, at: i }); i++; continue; }
    throw new Error(`rules: неожиданный символ «${c}» на позиции ${i}`);
  }
  toks.push({ t: "eof", v: null, at: n });
  return toks;
}

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const next = () => toks[p++];
  const is = (v, o = 0) => { const t = peek(o); return t.t !== "str" && t.v === v; };
  const expect = (v) => {
    const t = next();
    if (t.v !== v || t.t === "str") throw new Error(`rules: ожидалось «${v}», а не «${t.v}» на позиции ${t.at}`);
    return t;
  };

  // Путь в match: /a/{b}/{c=**}
  function matchPath() {
    const segs = [];
    while (is("/")) {
      next();
      if (is("{")) {
        next();
        const name = next().v;
        let rest = false;
        if (is("=")) { next(); expect("*"); expect("*"); rest = true; }
        expect("}");
        segs.push({ var: name, rest });
      } else {
        let s = "";
        while (!is("/") && !is("{") && peek().t !== "eof") {
          const t = peek();
          if (t.t === "id" || t.t === "num" || (t.t === "op" && (t.v === "-" || t.v === "." || t.v === "("  || t.v === ")"))) { s += String(next().v); continue; }
          break;
        }
        segs.push({ lit: s });
      }
    }
    return segs;
  }

  function block() {
    expect("{");
    const out = { matches: [], functions: {}, allows: [] };
    while (!is("}")) {
      const t = peek();
      if (t.v === "match") {
        next();
        const path = matchPath();
        const body = block();
        out.matches.push({ path, ...body });
      } else if (t.v === "function") {
        next();
        const name = next().v;
        expect("(");
        const params = [];
        while (!is(")")) { params.push(next().v); if (is(",")) next(); }
        expect(")");
        expect("{");
        const lets = [];
        let ret = null;
        while (!is("}")) {
          if (is("let")) {
            next();
            const v = next().v;
            expect("=");
            lets.push([v, expr()]);
            if (is(";")) next();
          } else if (is("return")) {
            next();
            ret = expr();
            if (is(";")) next();
          } else throw new Error(`rules: непонятное в функции ${name} на позиции ${peek().at}`);
        }
        expect("}");
        out.functions[name] = { params, lets, ret };
      } else if (t.v === "allow") {
        next();
        const methods = [];
        while (!is(":") && !is(";")) { methods.push(next().v); if (is(",")) next(); }
        let cond = { k: "lit", v: true };
        if (is(":")) {
          next();
          expect("if");
          cond = expr();
        }
        if (is(";")) next();
        out.allows.push({ methods, cond });
      } else throw new Error(`rules: непонятное «${t.v}» на позиции ${t.at}`);
    }
    expect("}");
    return out;
  }

  // Выражения — по приоритету: ?: → || → && → in/== → сравнения → +- → */% → унарные → постфиксы.
  function expr() { return ternary(); }
  function ternary() {
    const c = or();
    if (is("?")) {
      next();
      const a = expr();
      expect(":");
      const b = expr();
      return { k: "?", c, a, b };
    }
    return c;
  }
  function or() {
    let l = and();
    while (is("||")) { next(); l = { k: "||", l, r: and() }; }
    return l;
  }
  function and() {
    let l = eq();
    while (is("&&")) { next(); l = { k: "&&", l, r: eq() }; }
    return l;
  }
  function eq() {
    let l = rel();
    for (;;) {
      if (is("==") || is("!=")) { const op = next().v; l = { k: op, l, r: rel() }; continue; }
      break;
    }
    return l;
  }
  function rel() {
    let l = add();
    for (;;) {
      if (is("<") || is("<=") || is(">") || is(">=")) { const op = next().v; l = { k: op, l, r: add() }; continue; }
      if (is("in")) { next(); l = { k: "in", l, r: add() }; continue; }
      if (is("is")) { next(); l = { k: "is", l, t: next().v }; continue; }
      break;
    }
    return l;
  }
  function add() {
    let l = mul();
    while (is("+") || is("-")) { const op = next().v; l = { k: op, l, r: mul() }; }
    return l;
  }
  function mul() {
    let l = unary();
    while (is("*") || is("/") || is("%")) { const op = next().v; l = { k: op, l, r: unary() }; }
    return l;
  }
  function unary() {
    if (is("!")) { next(); return { k: "!", e: unary() }; }
    if (is("-")) { next(); return { k: "neg", e: unary() }; }
    return postfix(primary());
  }
  function args() {
    expect("(");
    const a = [];
    while (!is(")")) { a.push(expr()); if (is(",")) next(); }
    expect(")");
    return a;
  }
  function postfix(e) {
    for (;;) {
      if (is(".")) {
        next();
        const name = next().v;
        if (is("(")) e = { k: "call", obj: e, name, args: args() };
        else e = { k: ".", obj: e, name };
        continue;
      }
      if (is("[")) {
        next();
        const idx = is(":") ? { k: "lit", v: 0 } : expr();
        if (is(":")) {
          next();
          const end = is("]") ? null : expr();
          expect("]");
          e = { k: "slice", obj: e, from: idx, to: end };
          continue;
        }
        expect("]");
        e = { k: "[]", obj: e, idx };
        continue;
      }
      return e;
    }
  }
  // Путь-литерал: /databases/$(database)/documents/tenants/$(id)
  function pathLit() {
    const parts = [];
    while (is("/")) {
      next();
      if (is("$")) {
        next();
        expect("(");
        parts.push({ e: expr() });
        expect(")");
      } else {
        let s = "";
        while (peek().t === "id" || peek().t === "num" || (peek().t === "op" && peek().v === "-")) s += String(next().v);
        parts.push({ s });
      }
    }
    return { k: "path", parts };
  }
  function primary() {
    const t = peek();
    if (t.t === "num") { next(); return { k: "lit", v: t.v }; }
    if (t.t === "str") { next(); return { k: "lit", v: t.v }; }
    if (t.t === "op" && t.v === "(") { next(); const e = expr(); expect(")"); return e; }
    if (t.t === "op" && t.v === "[") {
      next();
      const items = [];
      while (!is("]")) { items.push(expr()); if (is(",")) next(); }
      expect("]");
      return { k: "list", items };
    }
    if (t.t === "op" && t.v === "{") {
      next();
      const entries = [];
      while (!is("}")) { const key = expr(); expect(":"); entries.push([key, expr()]); if (is(",")) next(); }
      expect("}");
      return { k: "map", entries };
    }
    if (t.t === "op" && t.v === "/") return pathLit();
    if (t.t === "id") {
      next();
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      if (is("(")) return { k: "fn", name: t.v, args: args() };
      return { k: "id", name: t.v };
    }
    throw new Error(`rules: неожиданное «${t.v}» на позиции ${t.at}`);
  }

  // Верхний уровень: rules_version; service cloud.firestore { match /databases/{database}/documents { ... } }
  const root = { matches: [], functions: {}, allows: [] };
  while (peek().t !== "eof") {
    if (is("rules_version")) { next(); expect("="); next(); if (is(";")) next(); continue; }
    if (is("service")) {
      next();
      while (!is("{")) next();
      const b = block();
      root.matches.push(...b.matches);
      Object.assign(root.functions, b.functions);
      continue;
    }
    throw new Error(`rules: непонятное «${peek().v}» на верхнем уровне`);
  }
  return root;
}

// ------------------------------------------------------------ вычисление

const READ = new Set(["get", "list"]);
const WRITE = new Set(["create", "update", "delete"]);

function methodCovers(m, wanted) {
  return m === wanted || (m === "read" && READ.has(wanted)) || (m === "write" && WRITE.has(wanted));
}

/** Сопоставить сегменты match с сегментами пути; возвращает привязки и остаток. */
function matchSegments(pattern, segs, from) {
  const vars = {};
  let i = from;
  for (let k = 0; k < pattern.length; k++) {
    const p = pattern[k];
    if (p.rest) {
      vars[p.var] = new RPath(segs.slice(i).join("/"));
      return { vars, end: segs.length, rest: true };
    }
    if (i >= segs.length) return null;
    if (p.lit !== undefined) {
      if (p.lit !== segs[i]) return null;
    } else vars[p.var] = segs[i];
    i++;
  }
  return { vars, end: i, rest: false };
}

function compile(src) {
  const root = parse(src);

  /** Все блоки allow, чьи match покрывают путь документа целиком. */
  function collect(path) {
    const segs = ["databases", "(default)", "documents", ...path.split("/").filter(Boolean)];
    const out = [];
    const walk = (node, from, vars, fnScopes) => {
      for (const m of node.matches) {
        const r = matchSegments(m.path, segs, from);
        if (!r) continue;
        const v = { ...vars, ...r.vars };
        const scopes = [m.functions, ...fnScopes];
        if (r.end === segs.length) out.push({ allows: m.allows, vars: v, scopes });
        if (!r.rest) walk(m, r.end, v, scopes);
      }
    };
    walk(root, 0, {}, [root.functions]);
    return out;
  }

  function evaluate(e, env) {
    switch (e.k) {
      case "lit": return e.v;
      case "list": return e.items.map((x) => evaluate(x, env));
      case "map": {
        const o = {};
        for (const [k, v] of e.entries) o[evaluate(k, env)] = evaluate(v, env);
        return o;
      }
      case "id": return lookup(e.name, env);
      case "path": {
        const s = e.parts.map((x) => (x.e ? String(unwrapPath(evaluate(x.e, env))) : x.s)).join("/");
        return new RPath(s);
      }
      case "||": {
        let lerr = null;
        try { if (evaluate(e.l, env) === true) return true; } catch (err) { if (!(err instanceof RulesError)) throw err; lerr = err; }
        const r = evaluate(e.r, env);
        if (r === true) return true;
        if (lerr) throw lerr;
        return false;
      }
      case "&&": {
        let lerr = null;
        try { if (evaluate(e.l, env) !== true) return false; } catch (err) { if (!(err instanceof RulesError)) throw err; lerr = err; }
        const r = evaluate(e.r, env);
        if (r !== true) return false;
        if (lerr) throw lerr;
        return true;
      }
      case "!": {
        const v = evaluate(e.e, env);
        if (typeof v !== "boolean") fail("! не к логическому значению");
        return !v;
      }
      case "neg": return -num(evaluate(e.e, env));
      case "?": return evaluate(e.c, env) === true ? evaluate(e.a, env) : evaluate(e.b, env);
      case "==": return equal(evaluate(e.l, env), evaluate(e.r, env));
      case "!=": return !equal(evaluate(e.l, env), evaluate(e.r, env));
      case "<": return compare(evaluate(e.l, env), evaluate(e.r, env)) < 0;
      case "<=": return compare(evaluate(e.l, env), evaluate(e.r, env)) <= 0;
      case ">": return compare(evaluate(e.l, env), evaluate(e.r, env)) > 0;
      case ">=": return compare(evaluate(e.l, env), evaluate(e.r, env)) >= 0;
      case "in": {
        const l = evaluate(e.l, env);
        const r = evaluate(e.r, env);
        if (Array.isArray(r)) return r.some((x) => equal(x, l));
        if (r instanceof RSet) return r.items.some((x) => equal(x, l));
        if (isMap(r)) return typeof l === "string" && Object.prototype.hasOwnProperty.call(r, l);
        return fail(`in к ${typeName(r)}`);
      }
      case "is": return isType(evaluate(e.l, env), e.t);
      case "+": {
        const l = evaluate(e.l, env);
        const r = evaluate(e.r, env);
        if (typeof l === "string" && typeof r === "string") return l + r;
        if (typeof l === "number" && typeof r === "number") return l + r;
        if (l instanceof RTime && r instanceof RDur) return new RTime(l.ms + r.ms);
        if (l instanceof RDur && r instanceof RTime) return new RTime(l.ms + r.ms);
        if (l instanceof RDur && r instanceof RDur) return new RDur(l.ms + r.ms);
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        return fail(`+ для ${typeName(l)} и ${typeName(r)}`);
      }
      case "-": {
        const l = evaluate(e.l, env);
        const r = evaluate(e.r, env);
        if (typeof l === "number" && typeof r === "number") return l - r;
        if (l instanceof RTime && r instanceof RDur) return new RTime(l.ms - r.ms);
        if (l instanceof RTime && r instanceof RTime) return new RDur(l.ms - r.ms);
        if (l instanceof RDur && r instanceof RDur) return new RDur(l.ms - r.ms);
        return fail(`- для ${typeName(l)} и ${typeName(r)}`);
      }
      case "*": return num(evaluate(e.l, env)) * num(evaluate(e.r, env));
      case "/": {
        const l = num(evaluate(e.l, env));
        const r = num(evaluate(e.r, env));
        if (r === 0) fail("деление на ноль");
        return Number.isInteger(l) && Number.isInteger(r) ? Math.trunc(l / r) : l / r;
      }
      case "%": return num(evaluate(e.l, env)) % num(evaluate(e.r, env));
      case ".": return member(evaluate(e.obj, env), e.name, e);
      case "[]": {
        const o = evaluate(e.obj, env);
        const i = evaluate(e.idx, env);
        if (Array.isArray(o)) {
          if (typeof i !== "number" || i < 0 || i >= o.length) fail("индекс вне списка");
          return o[i];
        }
        if (isMap(o)) {
          if (!Object.prototype.hasOwnProperty.call(o, i)) fail(`нет ключа ${i}`);
          return o[i];
        }
        return fail(`[] к ${typeName(o)}`);
      }
      case "slice": {
        const o = evaluate(e.obj, env);
        const from = num(evaluate(e.from, env));
        const to = e.to ? num(evaluate(e.to, env)) : null;
        if (!Array.isArray(o) && typeof o !== "string") fail(`срез ${typeName(o)}`);
        return o.slice(from, to === null ? undefined : to);
      }
      case "call": return method(e, env);
      case "fn": return callFn(e, env);
      default: throw new Error(`rules: неизвестный узел ${e.k}`);
    }
  }

  const num = (v) => (typeof v === "number" ? v : fail(`ожидалось число, а не ${typeName(v)}`));
  const unwrapPath = (v) => (v instanceof RPath ? v.s : v);

  function lookup(name, env) {
    for (let s = env; s; s = s.parent) if (Object.prototype.hasOwnProperty.call(s.vars, name)) return s.vars[name];
    if (name === "duration" || name === "timestamp" || name === "math" || name === "request" || name === "resource") return fail(`${name} без значения`);
    return fail(`неизвестное имя ${name}`);
  }

  function member(o, name) {
    if (o === null || o === undefined) return fail(`.${name} у null`);
    if (isMap(o)) {
      if (!Object.prototype.hasOwnProperty.call(o, name)) return fail(`нет поля ${name}`);
      return o[name];
    }
    return fail(`.${name} у ${typeName(o)}`);
  }

  function setOf(v) {
    if (v instanceof RSet) return v.items;
    if (Array.isArray(v)) return v;
    return fail(`ожидался список, а не ${typeName(v)}`);
  }

  function method(e, env) {
    const name = e.name;
    // duration.value / timestamp.value / math.* — объекты-пространства имён.
    if (e.obj.k === "id" && e.obj.name === "duration" && !hasVar("duration", env)) {
      const a = e.args.map((x) => evaluate(x, env));
      if (name === "value") return new RDur(num(a[0]) * (UNITS[a[1]] ?? fail(`единица ${a[1]}`)));
      if (name === "time") return new RDur(((num(a[0]) * 60 + num(a[1])) * 60 + num(a[2])) * 1000 + num(a[3] || 0) / 1e6);
      return fail(`duration.${name}`);
    }
    if (e.obj.k === "id" && e.obj.name === "timestamp" && !hasVar("timestamp", env)) {
      const a = e.args.map((x) => evaluate(x, env));
      if (name === "value") return new RTime(num(a[0]));
      if (name === "date") return new RTime(Date.UTC(num(a[0]), num(a[1]) - 1, num(a[2])));
      return fail(`timestamp.${name}`);
    }
    if (e.obj.k === "id" && e.obj.name === "math" && !hasVar("math", env)) {
      const a = e.args.map((x) => evaluate(x, env));
      const f = { abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, sqrt: Math.sqrt }[name];
      return f ? f(num(a[0])) : fail(`math.${name}`);
    }
    const o = evaluate(e.obj, env);
    const a = e.args.map((x) => evaluate(x, env));
    if (isMap(o)) {
      switch (name) {
        case "keys": return Object.keys(o);
        case "values": return Object.values(o);
        case "size": return Object.keys(o).length;
        case "get": {
          const key = a[0];
          if (Array.isArray(key)) {
            let cur = o;
            for (const k of key) {
              if (!isMap(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return a[1];
              cur = cur[k];
            }
            return cur;
          }
          return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : a[1];
        }
        case "diff": {
          const other = a[0];
          if (!isMap(other)) fail("diff не с картой");
          const keys = new Set([...Object.keys(o), ...Object.keys(other)]);
          const added = [];
          const removed = [];
          const changed = [];
          const same = [];
          for (const k of keys) {
            const inA = Object.prototype.hasOwnProperty.call(o, k);
            const inB = Object.prototype.hasOwnProperty.call(other, k);
            if (inA && !inB) added.push(k);
            else if (!inA && inB) removed.push(k);
            else if (!equal(o[k], other[k])) changed.push(k);
            else same.push(k);
          }
          return { __diff: true, added, removed, changed, same };
        }
        default: break;
      }
      if (o.__diff) {
        switch (name) {
          case "affectedKeys": return new RSet([...o.added, ...o.removed, ...o.changed]);
          case "addedKeys": return new RSet(o.added);
          case "removedKeys": return new RSet(o.removed);
          case "changedKeys": return new RSet(o.changed);
          case "unchangedKeys": return new RSet(o.same);
          default: break;
        }
      }
      return fail(`у карты нет метода ${name}`);
    }
    if (Array.isArray(o) || o instanceof RSet) {
      const items = setOf(o);
      switch (name) {
        case "size": return items.length;
        case "hasOnly": return items.every((x) => setOf(a[0]).some((y) => equal(x, y)));
        case "hasAny": return setOf(a[0]).some((y) => items.some((x) => equal(x, y)));
        case "hasAll": return setOf(a[0]).every((y) => items.some((x) => equal(x, y)));
        case "join": return items.join(a[0] ?? "");
        case "toSet": return new RSet(items.filter((x, i) => items.findIndex((y) => equal(x, y)) === i));
        case "concat": return [...items, ...setOf(a[0])];
        case "removeAll": return items.filter((x) => !setOf(a[0]).some((y) => equal(x, y)));
        case "difference": return new RSet(items.filter((x) => !setOf(a[0]).some((y) => equal(x, y))));
        case "intersection": return new RSet(items.filter((x) => setOf(a[0]).some((y) => equal(x, y))));
        case "union": return new RSet([...items, ...setOf(a[0]).filter((y) => !items.some((x) => equal(x, y)))]);
        default: return fail(`у списка нет метода ${name}`);
      }
    }
    if (typeof o === "string") {
      switch (name) {
        case "size": return [...o].length;
        case "matches": return new RegExp(`^(?:${a[0]})$`, "u").test(o);
        case "replace": return o.replace(new RegExp(a[0], "gu"), a[1]);
        case "lower": return o.toLowerCase();
        case "upper": return o.toUpperCase();
        case "trim": return o.trim();
        case "split": return o.split(new RegExp(a[0], "u"));
        default: return fail(`у строки нет метода ${name}`);
      }
    }
    if (o instanceof RTime) {
      switch (name) {
        case "toMillis": return o.ms;
        case "seconds": return Math.floor(o.ms / 1000);
        case "date": { const d = new Date(o.ms); return new RTime(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
        default: return fail(`у времени нет метода ${name}`);
      }
    }
    if (o instanceof RDur) {
      if (name === "seconds") return Math.trunc(o.ms / 1000);
      if (name === "nanos") return Math.round((o.ms % 1000) * 1e6);
      return fail(`у длительности нет метода ${name}`);
    }
    return fail(`метод ${name} у ${typeName(o)}`);
  }

  function hasVar(name, env) {
    for (let s = env; s; s = s.parent) if (Object.prototype.hasOwnProperty.call(s.vars, name)) return true;
    return false;
  }

  function findFn(name, env) {
    for (let s = env; s; s = s.parent) if (s.scopes) for (const sc of s.scopes) if (sc[name]) return sc[name];
    return null;
  }

  function callFn(e, env) {
    const name = e.name;
    if (name === "get" || name === "exists" || name === "getAfter" || name === "existsAfter") {
      const pathV = evaluate(e.args[0], env);
      const s = unwrapPath(pathV);
      if (typeof s !== "string") fail("get() не с путём");
      const m = s.match(/^\/?databases\/[^/]+\/documents\/(.+)$/);
      const docPath = m ? m[1] : s.replace(/^\//, "");
      const ctx = env.root.ctx;
      const after = name === "getAfter" || name === "existsAfter";
      const data = after ? ctx.getAfter(docPath) : ctx.get(docPath);
      if (name === "exists" || name === "existsAfter") return data !== null && data !== undefined;
      if (data === null || data === undefined) return null;
      return { data: fromData(data), id: docPath.split("/").pop(), __name__: new RPath(`/databases/(default)/documents/${docPath}`) };
    }
    if (name === "string") { const v = evaluate(e.args[0], env); return v instanceof RPath ? v.s : String(v); }
    if (name === "int") return Math.trunc(Number(evaluate(e.args[0], env)));
    if (name === "float") return Number(evaluate(e.args[0], env));
    if (name === "path") return new RPath(String(evaluate(e.args[0], env)));
    const fn = findFn(name, env);
    if (!fn) return fail(`нет функции ${name}`);
    if (fn.params.length !== e.args.length) return fail(`функция ${name}: число аргументов`);
    const vars = {};
    fn.params.forEach((p, i) => { vars[p] = evaluate(e.args[i], env); });
    const local = { vars, parent: env.fnParent || env, scopes: env.scopes, root: env.root, fnParent: env.fnParent || env };
    for (const [v, x] of fn.lets) local.vars[v] = evaluate(x, local);
    if (!fn.ret) return fail(`функция ${name} без return`);
    return evaluate(fn.ret, local);
  }

  /**
   * Разрешено ли действие [method] (get, list, create, update, delete) над
   * документом [path]. ctx: { auth: { uid, token } | null, resource: данные
   * до | null, request: данные после | null, get(path), getAfter(path), now }.
   */
  function allowed(method, path, ctx) {
    const blocks = collect(path);
    const now = new RTime(ctx.now || Date.now());
    const auth = ctx.auth ? { uid: ctx.auth.uid, token: fromData(ctx.auth.token || {}) } : null;
    const resource = ctx.resource ? { data: fromData(ctx.resource), id: path.split("/").pop(), __name__: new RPath(`/databases/(default)/documents/${path}`) } : null;
    const reqResource = ctx.request ? { data: fromData(ctx.request), id: path.split("/").pop(), __name__: new RPath(`/databases/(default)/documents/${path}`) } : null;
    const root = { ctx };
    for (const b of blocks) {
      for (const a of b.allows) {
        if (!a.methods.some((m) => methodCovers(m, method))) continue;
        const env = {
          vars: { ...b.vars, database: "(default)", request: { auth, time: now, resource: reqResource, method, path: new RPath(path) }, resource },
          parent: null, scopes: b.scopes, root,
        };
        try {
          if (evaluate(a.cond, env) === true) return true;
        } catch (err) {
          if (!(err instanceof RulesError)) throw err;
        }
      }
    }
    return false;
  }

  return { allowed, parse: () => root };
}

module.exports = { compile, parse, RulesError, RTime, RDur };
