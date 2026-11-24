// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- sections 3 and 5: files, lines, three-tier matching -------------------

interface FileShape {
  lines: string[];
  br: string;
  final: boolean;
}
type Tag = 'ctx' | 'old' | 'new';
interface BodyItem {
  tag: Tag;
  text: string;
  rawEmpty?: boolean;
  noNewline?: boolean;
}
interface Move {
  old: string;
  neu: string;
}

function fileShape(text: string): FileShape {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(f: FileShape): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leading = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const tierKey = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? rstrip(s) : stripBoth(s));

/** The occurrences of O in the file at one tier, at or after `from`. */
function atTier(file: string[], old: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const keys = old.map((l) => tierKey(l, tier));
  const out: number[] = [];
  for (let i = Math.max(0, from); i + keys.length <= file.length; i += 1) {
    if (eofOnly && i + keys.length !== file.length) continue;
    let ok = true;
    for (let j = 0; j < keys.length; j += 1) {
      if (tierKey(file[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence, and all its occurrences. */
function matchOld(file: string[], old: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; positions: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const positions = atTier(file, old, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function writtenLines(f: FileShape, pos: number, oldLen: number, items: BodyItem[], tier: number, oFirst: string): string[] {
  const F = leading(f.lines[pos] ?? '');
  const P = leading(oFirst);
  const matched = f.lines.slice(pos, pos + oldLen);
  const out: string[] = [];
  let k = 0;
  for (const item of items) {
    if (item.tag === 'old') {
      k += 1;
      continue;
    }
    if (item.tag === 'ctx') {
      out.push(k < matched.length ? matched[k]! : item.text);
      k += 1;
      continue;
    }
    if (tier < 2 || item.text.trim() === '') out.push(item.text);
    else out.push(item.text.startsWith(P) ? F + item.text.slice(P.length) : item.text);
  }
  return [...f.lines.slice(0, pos), ...out, ...f.lines.slice(pos + oldLen)];
}

/** The body over `oldLen` old lines: `items` in body order (old, new and context). */
function replaceRange(f: FileShape, pos: number, oldLen: number, items: BodyItem[], tier: number, oFirst: string): FileShape {
  return { ...f, lines: writtenLines(f, pos, oldLen, items, tier, oFirst) };
}

function oldOf(items: BodyItem[]): BodyItem[] {
  return items.filter((x) => x.tag !== 'new');
}
function newOf(items: BodyItem[]): BodyItem[] {
  return items.filter((x) => x.tag !== 'old');
}
function texts(items: BodyItem[]): string[] {
  return items.map((x) => x.text);
}

// ---- section 6: unified diffs ----------------------------------------------

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0]!.trim();
  return rest === '/dev/null' ? null : stripAB(rest);
}
function isNewSection(lines: string[], i: number): boolean {
  return lines[i]!.startsWith('diff --git ') || (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
}

interface Hunk {
  at: number;
  items: BodyItem[];
}

function parseSection(lines: string[], start: number, gitOld: string | null, gitNew: string | null, strict: boolean, moves: Move[]): { edit: Edit; next: number } {
  let oldPath = gitOld;
  let newPath = gitNew;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let creation = false;
  let deletion = false;
  let hadDiffHeader = false;
  let j = start;

  if (lines[j]!.startsWith('diff --git ')) j = start + 1;
  while (j < lines.length && !lines[j]!.startsWith('@@')) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ') && !hadDiffHeader) {
      oldPath = headerPath(l);
      newPath = headerPath(lines[j + 1]!);
      hadDiffHeader = true;
      j += 2;
      continue;
    }
    if (l.startsWith('--- ')) throw new Exit2(`error: parse ${j + 2}`);
    if (l.startsWith('rename from ')) renameFrom = stripAB(l.slice(12).trim());
    if (l.startsWith('rename to ')) renameTo = stripAB(l.slice(10).trim());
    if (l.startsWith('new file mode')) creation = true;
    if (l.startsWith('deleted file mode')) deletion = true;
    j += 1;
  }
  if (!hadDiffHeader && renameFrom !== null) oldPath = renameFrom;
  if (!hadDiffHeader && renameTo !== null) newPath = renameTo;
  if (oldPath === '/dev/null') oldPath = null;
  if (newPath === '/dev/null') newPath = null;
  if (creation || oldPath === null) oldPath = null;
  if (deletion || newPath === null) newPath = null;

  const hunks: Hunk[] = [];
  while (j < lines.length && lines[j]!.startsWith('@@')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[j]!);
    if (m === null) throw new Exit2(`error: parse ${j + 1}`);
    const at = Number(m[1]);
    j += 1;
    const items: BodyItem[] = [];
    while (j < lines.length && !isNewSection(lines, j) && !lines[j]!.startsWith('@@')) {
      const l = lines[j]!;
      let item: BodyItem | null = null;
      if (l.startsWith(' ')) item = { tag: 'ctx', text: l.slice(1) };
      else if (l.startsWith('-')) item = { tag: 'old', text: l.slice(1) };
      else if (l.startsWith('+')) item = { tag: 'new', text: l.slice(1) };
      else if (l === '') item = { tag: 'ctx', text: '', rawEmpty: true };
      else if (l.startsWith('\\')) {
        if (items.length > 0) items[items.length - 1]!.noNewline = true;
        j += 1;
        continue;
      } else break;
      items.push(item);
      j += 1;
    }
    while (items.length > 0 && items[items.length - 1]!.rawEmpty) items.pop();
    hunks.push({ at, items });
  }

  const edit: Edit = (tree) => {
    for (const p of [oldPath, newPath]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    if (creation || (oldPath === null && newPath !== null)) {
      const target = newPath!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const added = hunks.flatMap((h) => h.items.filter((x) => x.tag === 'new'));
      const last = added[added.length - 1];
      tree.now.set(target, renderFile({ lines: texts(added), br: '\n', final: last === undefined || !last.noNewline }));
      return;
    }
    if (deletion || newPath === null) {
      const target = oldPath!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldPath!;
    const dst = newPath!;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (src !== dst && tree.get(dst) !== null) throw new Fail('exists', dst);
    let f = fileShape(before);
    let delta = 0;
    for (const h of hunks) {
      const O = oldOf(h.items);
      let pos: number;
      let tier = 0;
      if (O.length > 0) {
        const found = matchOld(f.lines, texts(O), strict);
        if (found === null) throw new Fail('no-match', src);
        tier = found.tier;
        const want = h.at - 1 + delta;
        pos = found.positions.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
      } else {
        pos = Math.min(Math.max(h.at + delta, 0), f.lines.length);
      }
      const atEnd = O.length > 0 ? pos + O.length === f.lines.length : pos === f.lines.length;
      f = replaceRange(f, pos, O.length, h.items, tier, O[0]?.text ?? '');
      if (atEnd) {
        const last = h.items[h.items.length - 1];
        if (last !== undefined) f.final = !last.noNewline;
      }
      delta += newOf(h.items).length - O.length;
    }
    tree.now.set(src, null);
    tree.now.set(dst, renderFile(f));
    if (src !== dst) moves.push({ old: src, neu: dst });
  };
  return { edit, next: j };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (lines[i]!.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[i]!);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = parseSection(lines, i, m[1]!, m[2]!, strict, moves);
      edits.push(s.edit);
      i = s.next;
    } else if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = parseSection(lines, i, null, null, strict, moves);
      edits.push(s.edit);
      i = s.next;
    } else i += 1;
  }
  return edits;
}

// ---- section 7: SEARCH/REPLACE --------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let previous = -1;
  let lastPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let p: string | null = null;
    for (let k = s - 1; k > previous; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    const path = p ?? lastPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let e = s + 1;
    while (e < lines.length && lines[e]!.trimEnd() !== '=======') {
      if (lines[e]!.trimEnd() === '<<<<<<< SEARCH' || lines[e]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${s + 1}`);
      e += 1;
    }
    if (e >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let r = e + 1;
    while (r < lines.length && lines[r]!.trimEnd() !== '>>>>>>> REPLACE') r += 1;
    if (r >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    const target = path;
    edits.push((tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (oldLines.length === 0) {
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.now.set(target, renderFile({ lines: newLines, br: '\n', final: true }));
        return;
      }
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      const f = fileShape(before);
      const found = matchOld(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', target);
      if (found.positions.length !== 1) throw new Fail('ambiguous', target);
      const items = newLines.map((text) => ({ tag: 'new' as Tag, text }));
      tree.now.set(target, renderFile(replaceRange(f, found.positions[0]!, oldLines.length, items, found.tier, oldLines[0]!)));
    });
    lastPath = target;
    previous = r;
    i = r + 1;
  }
  return edits;
}

// ---- section 8: V4A --------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = lines[i]!.trim();
    const start = i;
    const kind = head.startsWith('*** Add File: ') ? 'add' : head.startsWith('*** Delete File: ') ? 'delete' : head.startsWith('*** Update File: ') ? 'update' : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = head.slice(head.indexOf(': ') + 2).trim();
    i += 1;
    const body: string[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.trim().startsWith('*** Add File: ') || l.trim().startsWith('*** Delete File: ') || l.trim().startsWith('*** Update File: ')) break;
      body.push(l);
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();

    if (kind === 'add') {
      const added: string[] = [];
      body.forEach((l, k) => {
        if (l.startsWith('+')) added.push(l.slice(1));
        else if (l === '') added.push('');
        else throw new Exit2(`error: parse ${start + 2 + k}`);
      });
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, renderFile({ lines: added, br: '\n', final: true }));
      });
      continue;
    }
    if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${start + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }

    let moveTo: string | null = null;
    let from = 0;
    if (body[0]?.trim().startsWith('*** Move to: ')) {
      moveTo = body[0]!.trim().slice(13).trim();
      from = 1;
    }
    const chunks: V4AChunk[] = [];
    let chunk: V4AChunk | null = null;
    for (let k = from; k < body.length; k += 1) {
      const l = body[k]!;
      const atLine = start + 2 + k;
      if (l.startsWith('@@')) {
        if (chunk !== null) chunks.push(chunk);
        chunk = { anchor: l.slice(2).trim() || null, eof: false, items: [] };
      } else if (l.trim() === '*** End of File') {
        if (chunk === null) chunk = { anchor: null, eof: true, items: [] };
        else chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
      } else if (l.trim().startsWith('*** ')) {
        throw new Exit2(`error: parse ${atLine}`);
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
        if (chunk === null) chunk = { anchor: null, eof: false, items: [] };
        const tag: Tag = l.startsWith('-') ? 'old' : l.startsWith('+') ? 'new' : 'ctx';
        chunk.items.push({ tag, text: tag === 'ctx' ? l.slice(1) : l.slice(1) });
      } else throw new Exit2(`error: parse ${atLine}`);
    }
    if (chunk !== null) chunks.push(chunk);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);

    edits.push((tree) => {
      for (const p of [path, moveTo]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let f = fileShape(before);
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const found = matchOld(f.lines, [c.anchor], strict, cursor);
          if (found === null) throw new Fail('no-match', path);
          cursor = found.positions[0]! + 1;
        }
        const O = oldOf(c.items);
        const N = newOf(c.items);
        let pos: number;
        let tier = 0;
        if (O.length > 0) {
          const found = matchOld(f.lines, texts(O), strict, cursor, c.eof);
          if (found === null) throw new Fail('no-match', path);
          tier = found.tier;
          pos = found.positions[0]!;
        } else pos = c.eof ? f.lines.length : cursor;
        f = replaceRange(f, pos, O.length, c.items, tier, O[0]?.text ?? '');
        cursor = pos + N.length;
      }
      tree.now.set(path, null);
      tree.now.set(moveTo ?? path, renderFile(f));
      if (moveTo !== null) moves.push({ old: path, neu: moveTo });
    });
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  const moves: Move[] = [];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict, moves) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const moved = moves.filter((m) => tree.original(m.old) !== null && tree.original(m.neu) === null);
  const rows: { key: string; text: string; path: string; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    if (moved.some((m) => m.old === p || m.neu === p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  for (const m of moved) {
    const now = tree.get(m.neu);
    rows.push({ key: m.neu, text: `R ${m.old} -> ${m.neu}`, path: m.neu, now });
  }
  if (!check) for (const m of moved) rmSync(m.old, { force: true });
  rows.sort((a, b) => byteOrder(a.key, b.key));
  for (const r of rows) {
    if (check) continue;
    if (r.now === null) rmSync(r.path, { force: true });
    else {
      mkdirSync(dirname(r.path), { recursive: true });
      writeFileSync(r.path, r.now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// ---------------------------------------------------------------------------
// What this file implements (notes for the next reader; no behaviour here).
//
// main.ts is mend, the whole of SPEC.md, not just the starter's subset:
//
//   - sections 1-3: argument parsing (options in any order, `--`, usage errors),
//     the exit-code contract (2 for usage/no-patch/format/parse, 1 with per-edit
//     error lines for failures, 0 with A/D/M/R lines for success), safe-path
//     rules, and the per-file line model (CRLF vs LF, final line break).
//   - section 4: `--format=auto` detection of the four patch formats, with
//     `error: format` when nothing fits.
//   - sections 5-8: the three readers — unified diffs (sections, hunks, creation/
//     deletion/move edits, hunk position hints), SEARCH/REPLACE blocks (path
//     inheritance, exactly-one match), and V4A patches (add/delete/update/move,
//     anchors, end-of-file chunks) — plus the three-tier line matcher that all
//     of them share, including `--strict` and tier-2 re-indentation.
//   - section 9: JSON edits (array or JSON Lines; create, str_replace with its
//     CRLF handling, insert).
//   - section 10: edits applied in order to an in-memory tree, every failure
//     reported, and nothing written to disk unless all edits succeed (`--check`
//     writes nothing at all).
//
// The lines below hand a graded trial over to runner.ts when MAKEFUN_ENV_URL is
// set; without it the file runs the CLI. Keep both as they are.
// ---------------------------------------------------------------------------

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
