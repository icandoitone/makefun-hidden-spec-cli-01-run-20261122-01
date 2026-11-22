// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool-call edits), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. SPEC.md in the kit
// is the whole contract; this file implements it section by section.
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Node 22, standard library only. No model calls, no network.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed: the code and the path the failure concerns. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, does not start with /,
 * holds no backslash, and none of its segments is empty, . or .. . */
function safePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Byte order of two paths, as UTF-8. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Section 5: a line as a tier reads it. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Section 5, tier 2: re-indent a new line from the patch's indent P to the
 * file's indent F. Empty and whitespace-only lines, and lines that do not
 * start with P, are written as they are. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** Section 3: a file as lines, its line break, and whether it ends with one. */
interface Doc {
  lines: string[];
  br: '\r\n' | '\n';
  eol: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.eol ? d.br : '');
}

/** Section 5: every position at or after `from` where O occurs at a tier. */
function tierOccurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const want = oldLines.map((l) => normLine(l, tier));
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Section 5: the first tier (0, then 1, then 2; only 0 when strict) at which
 * O occurs at least once, with every occurrence at that tier. */
function firstTier(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = tierOccurrences(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk. Moves are recorded so the output can print R lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

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

  private onDisk(p: string): 'file' | 'dir' | 'absent' {
    try {
      const st = statSync(p);
      if (st.isFile()) return 'file';
      if (st.isDirectory()) return 'dir';
      return 'absent';
    } catch {
      return 'absent';
    }
  }

  /** A file cannot be created at p: a file is already there, a directory is
   * there, a file sits on one of its parent paths, or a file sits below it. */
  blocked(p: string): boolean {
    if (this.get(p) !== null) return true;
    if (this.onDisk(p) === 'dir') return true;
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k++) {
      if (this.get(parts.slice(0, k).join('/')) !== null) return true;
    }
    for (const q of this.now.keys()) {
      if (q.startsWith(`${p}/`) && this.get(q) !== null) return true;
    }
    return false;
  }
}

type Edit = (tree: Tree) => void;

/** Section 4: detect the format, the first rule that holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\' | '';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkLine[];
}
interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

/** A --- or +++ header path: after the four characters, up to the first tab,
 * surrounding spaces removed, /dev/null meaning no file, a leading a/ or b/
 * removed. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function renamePath(line: string, prefixLen: number): string {
  let rest = line.slice(prefixLen);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  return rest.trim();
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split a hunk's body into its old lines O and its new lines N, keeping, for
 * each line of N, whether it is a context line and which line of O it is. */
function splitHunk(h: Hunk): {
  oLines: string[];
  nLines: Array<{ text: string; ctx: boolean; oIndex: number }>;
} {
  const oLines: string[] = [];
  const nLines: Array<{ text: string; ctx: boolean; oIndex: number }> = [];
  for (const b of h.body) {
    if (b.kind === ' ' || b.kind === '') {
      // A context line, and an empty body line, which is a context line
      // whose text is empty: both belong to O and to N.
      oLines.push(b.text);
      nLines.push({ text: b.text, ctx: true, oIndex: oLines.length - 1 });
    } else if (b.kind === '-') {
      oLines.push(b.text);
    } else if (b.kind === '+') {
      nLines.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { oLines, nLines };
}

/** Whether a \ line follows the hunk's last context or + line: the result
 * then ends without a line break. */
function hunkNoEol(h: Hunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j--) {
    const k = h.body[j]!.kind;
    if (k === ' ' || k === '' || k === '+') {
      return j + 1 < h.body.length && h.body[j + 1]!.kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file's lines. */
function applyUnifiedHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let d = 0;
  for (const h of hunks) {
    const { oLines, nLines } = splitHunk(h);
    const noEol = hunkNoEol(h);
    if (oLines.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...nLines.map((x) => x.text));
      if (atEnd) doc.eol = !noEol;
      d += nLines.length;
      continue;
    }
    const found = firstTier(doc.lines, oLines, strict, 0);
    if (found === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const runsToEnd = pos + oLines.length === doc.lines.length;
    const pLead = leadingWs(oLines[0]!);
    const fLead = leadingWs(doc.lines[pos]!);
    const rep = nLines.map((x) => {
      if (x.ctx) return doc.lines[pos + x.oIndex]!;
      return found.tier === 2 ? reindent(x.text, pLead, fLead) : x.text;
    });
    doc.lines.splice(pos, oLines.length, ...rep);
    if (runsToEnd) doc.eol = !noEol;
    d += nLines.length - oLines.length;
  }
  return doc;
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree: Tree) => {
    const oldPath =
      sec.pairOld !== undefined
        ? sec.pairOld
        : sec.renameFrom !== undefined
          ? sec.renameFrom
          : sec.diffOld;
    const newPath =
      sec.pairNew !== undefined
        ? sec.pairNew
        : sec.renameTo !== undefined
          ? sec.renameTo
          : sec.diffNew;
    const isCreation = oldPath === null || sec.isNew;
    const isDeletion = newPath === null || sec.isDeleted;
    if (isCreation) {
      if (newPath === null || newPath === undefined) return;
      if (!safePath(newPath)) throw new EditFail('unsafe', newPath);
      if (tree.blocked(newPath)) throw new EditFail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      }
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        for (let j = h.body.length - 1; j >= 0; j--) {
          if (h.body[j]!.kind === '+') {
            noEol = j + 1 < h.body.length && h.body[j + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      if (oldPath === null || oldPath === undefined) return;
      if (!safePath(oldPath)) throw new EditFail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new EditFail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === undefined || newPath === undefined) return;
    if (oldPath !== newPath) {
      if (!safePath(oldPath)) throw new EditFail('unsafe', oldPath);
      if (!safePath(newPath)) throw new EditFail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new EditFail('missing', oldPath);
      if (tree.blocked(newPath)) throw new EditFail('exists', newPath);
      const doc = applyUnifiedHunks(parseDoc(before), sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, renderDoc(doc));
      tree.moves.push([oldPath, newPath]);
      return;
    }
    if (!safePath(oldPath)) throw new EditFail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new EditFail('missing', oldPath);
    const doc = applyUnifiedHunks(parseDoc(before), sec.hunks, strict, oldPath);
    tree.now.set(oldPath, renderDoc(doc));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const blankSection = (): UnifiedSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    isNew: false,
    isDeleted: false,
    hunks: [],
  });
  while (i < n) {
    const line = lines[i]!;
    const next = i + 1 < n ? lines[i + 1]! : '';
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = blankSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      if (sec !== null && inHeader) {
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(next);
        i += 2;
        continue;
      }
      sec = blankSection();
      sec.pairOld = headerPath(line);
      sec.pairNew = headerPath(next);
      sections.push(sec);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      i += 1;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (i + 1 < n ? lines[i + 1]! : '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push({
            kind: b === '' ? '' : (b[0] as ' ' | '-' | '+' | '\\'),
            text: b === '' ? '' : b.slice(1),
          });
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === '') hunk.body.pop();
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        sec.pairNew = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = renamePath(line, 12);
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = renamePath(line, 10);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDeleted = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.blocked(path)) throw new EditFail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    const doc = parseDoc(before);
    const found = firstTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new EditFail('no-match', path);
    if (found.occ.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.occ[0]!;
    const pLead = leadingWs(oldLines[0]!);
    const fLead = leadingWs(doc.lines[pos]!);
    const rep = newLines.map((l) => (found.tier === 2 ? reindent(l, pLead, fLead) : l));
    doc.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, renderDoc(doc));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let m = searchLine - 1; m > prevEnd; m--) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(i + 1, j), lines.slice(j + 1, k), strict));
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: HunkLine[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree: Tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (tree.blocked(path)) throw new EditFail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) === null) throw new EditFail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after the cursor equal to the anchor, at the first
 * tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/** The first occurrence of O at or after the cursor, at the first tier with
 * one; an end-of-file chunk takes only an occurrence ending at the last line. */
function findFirstAtOrAfter(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
  eof: boolean,
): { tier: number; pos: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = tierOccurrences(lines, oldLines, t, from);
    const good = eof ? occ.filter((p) => p + oldLines.length === lines.length) : occ;
    if (good.length > 0) return { tier: t, pos: good[0]! };
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== undefined && !safePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== undefined && tree.blocked(moveTo)) throw new EditFail('exists', moveTo);
    const doc = parseDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(doc.lines, ch.anchor, strict, cursor);
        if (at === null) throw new EditFail('no-match', path);
        cursor = at + 1;
      }
      const { oLines, nLines } = splitHunk({ a: 0, body: ch.body });
      if (oLines.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...nLines.map((x) => x.text));
        cursor = at + nLines.length;
        continue;
      }
      const found = findFirstAtOrAfter(doc.lines, oLines, strict, cursor, ch.eof);
      if (found === null) throw new EditFail('no-match', path);
      const pos = found.pos;
      const pLead = leadingWs(oLines[0]!);
      const fLead = leadingWs(doc.lines[pos]!);
      const rep = nLines.map((x) => {
        if (x.ctx) return doc.lines[pos + x.oIndex]!;
        return found.tier === 2 ? reindent(x.text, pLead, fLead) : x.text;
      });
      doc.lines.splice(pos, oLines.length, ...rep);
      cursor = pos + rep.length;
    }
    const text = renderDoc(doc);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function isV4aSectionStart(l: string): boolean {
  return (
    l.startsWith('*** Add File: ') ||
    l.startsWith('*** Delete File: ') ||
    l.startsWith('*** Update File: ')
  );
}

function parseV4aSection(
  lines: string[],
  start: number,
  last: number,
  edits: Edit[],
  strict: boolean,
): number {
  const head = lines[start]!;
  let kind: 'add' | 'delete' | 'update';
  let path: string;
  if (head.startsWith('*** Add File: ')) {
    kind = 'add';
    path = head.slice('*** Add File: '.length).trim();
  } else if (head.startsWith('*** Delete File: ')) {
    kind = 'delete';
    path = head.slice('*** Delete File: '.length).trim();
  } else {
    kind = 'update';
    path = head.slice('*** Update File: '.length).trim();
  }
  let end = start + 1;
  while (end <= last) {
    const l = lines[end]!;
    if (l.trim() === '*** End Patch') break;
    if (isV4aSectionStart(l)) break;
    end++;
  }
  let bodyEnd = end;
  while (bodyEnd > start + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd--;
  const body = lines.slice(start + 1, bodyEnd);
  const lineNo = (j: number): number => start + 2 + j;
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let j = 0; j < body.length; j++) {
      const l = body[j]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${lineNo(j)}`);
    }
    edits.push(v4aAddEdit(path, fileLines));
    return end;
  }
  if (kind === 'delete') {
    for (let j = 0; j < body.length; j++) throw new Exit2(`error: parse ${lineNo(j)}`);
    edits.push(v4aDeleteEdit(path));
    return end;
  }
  let moveTo: string | undefined;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let seenChunk = false;
  for (let j = 0; j < body.length; j++) {
    const l = body[j]!;
    const no = lineNo(j);
    if (j === 0 && l.startsWith('*** Move to: ')) {
      moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      seenChunk = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (!seenChunk) {
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
          seenChunk = true;
        } else if (l === '') {
          continue;
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      cur.body.push({
        kind: l === '' ? '' : (l[0] as ' ' | '-' | '+'),
        text: l === '' ? '' : l.slice(1),
      });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${start + 1}`);
  edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  return end;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i <= last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.trim() === '*** End Patch') {
      if (i !== last) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (isV4aSectionStart(line)) {
      i = parseV4aSection(lines, i, last, edits, strict);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

function jsonCreateEdit(p: string, text: string): Edit {
  return (tree: Tree) => {
    if (!safePath(p)) throw new EditFail('unsafe', p);
    if (tree.blocked(p)) throw new EditFail('exists', p);
    tree.now.set(p, text);
  };
}

function jsonStrReplaceEdit(p: string, oldStr: string, newStr: string): Edit {
  return (tree: Tree) => {
    if (!safePath(p)) throw new EditFail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new EditFail('missing', p);
    const nl = before.indexOf('\n');
    const crlf = nl > 0 && before[nl - 1] === '\r';
    const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
    const text = flat(before);
    const old = flat(oldStr);
    let count = 0;
    for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
    if (count === 0) throw new EditFail('no-match', p);
    if (count > 1) throw new EditFail('ambiguous', p);
    const at = text.indexOf(old);
    const out = text.slice(0, at) + flat(newStr) + text.slice(at + old.length);
    tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
  };
}

function jsonInsertEdit(p: string, insertLine: number, newStr: string): Edit {
  return (tree: Tree) => {
    if (!safePath(p)) throw new EditFail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new EditFail('missing', p);
    const doc = parseDoc(before);
    if (insertLine < 0 || insertLine > doc.lines.length) throw new EditFail('no-match', p);
    doc.lines.splice(insertLine, 0, ...patchLines(newStr));
    tree.now.set(p, renderDoc(doc));
  };
}

/** One JSON edit object, or null when it is not one. A wrong command or a
 * missing or mistyped key is a parse fault. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return jsonCreateEdit(p, o.file_text);
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return jsonStrReplaceEdit(p, o.old_str, (o.new_str as string | undefined) ?? '');
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return jsonInsertEdit(p, o.insert_line, o.new_str);
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
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
      const e = jsonEditObject(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: invocation, output, order and atomicity
// ---------------------------------------------------------------------------

/** The output rows for a successful run, moves printed as R lines sorted by
 * their new path, everything else by its path, both in UTF-8 byte order. */
function outputRows(tree: Tree): string[] {
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const di = rows.findIndex((r) => r.text === `D ${oldP}`);
    const ai = rows.findIndex((r) => r.text === `A ${newP}`);
    if (di >= 0 && ai >= 0) {
      rows.splice(Math.max(di, ai), 1);
      rows.splice(Math.min(di, ai), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  return rows.map((r) => r.text);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = outputRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

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
