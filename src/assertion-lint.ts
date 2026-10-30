/**
 * Post-generation tautology lint.
 *
 * A generated spec that cannot fail is worse than no spec: it inflates the
 * count, and a customer who reads one (`toHaveURL(/.*\/)`, "body is visible")
 * stops trusting the whole suite. This module decides, without running
 * anything, whether a spec contains at least one assertion that a real page
 * could falsify. It is deliberately a heuristic scanner rather than a full
 * parser: the vacuous patterns a model produces are few and stable, and a
 * false "ok" costs nothing more than today, while a false rejection would
 * throw away a real test — so every rule below only fires on shapes that are
 * unfalsifiable by construction.
 */

import type { GeneratedTest } from './types';

export interface VacuousAssertion {
  /** The assertion source, trimmed to one line for logs. */
  snippet: string;
  /** Why it can never fail. */
  reason: string;
}

export interface AssertionLintResult {
  /** True when at least one assertion in the file can fail. */
  ok: boolean;
  /** Number of expect(...) assertions found. */
  total: number;
  /** Assertions judged unfalsifiable. */
  vacuous: VacuousAssertion[];
  /** One-line explanation when `ok` is false. */
  reason?: string;
}

export interface RejectedTest {
  filename: string;
  reason: string;
}

interface ParsedAssertion {
  /** Text inside expect( ... ), or the expect.poll/soft argument. */
  subject: string;
  /** `not`, `resolves`, `rejects` modifiers between subject and matcher. */
  modifiers: string[];
  /** Matcher name, e.g. toHaveURL. Empty when the chain was not completed. */
  matcher: string;
  /** Raw matcher argument list text (without the outer parentheses). */
  args: string;
  /** Source of the whole assertion, for reporting. */
  snippet: string;
}

/**
 * Probe strings a "matches anything" pattern must accept. Deliberately
 * dissimilar (scheme, host, shape), so a pattern that checks a real property
 * — `/^https?:\/\//`, `/localhost/` — fails at least one and is kept.
 */
const URL_PROBES = [
  'http://localhost:3000/',
  'https://example.com/a/b?c=d#e',
  'about:blank',
  'file:///tmp/index.html',
  'x',
];
const TEXT_PROBES = ['', 'x', 'Lorem ipsum dolor', 'Invoice #42 — $1,200.00', '\n\tTab\n'];

/** Matchers whose single pattern argument is checked against the probes. */
const URL_MATCHERS = new Set(['toHaveURL']);
/** Exact-value matchers: '' is a real (falsifiable) expectation here. */
const EXACT_TEXT_MATCHERS = new Set([
  'toHaveText',
  'toHaveTitle',
  'toHaveValue',
  'toHaveAccessibleName',
  'toHaveAccessibleDescription',
]);
/** Substring matchers: '' is contained in everything. */
const SUBSTRING_MATCHERS = new Set(['toContainText', 'toMatch', 'toContain']);

/** `expect(<this>).toBeVisible()` cannot fail: the document root is always rendered. */
const ROOT_LOCATOR = /^page\.locator\(\s*(['"`])(?:body|html|:root)\1\s*\)$/;
const EXISTENCE_MATCHERS_FOR_ROOT = new Set([
  'toBeVisible',
  'toBeAttached',
  'toBeInViewport',
  'toBeDefined',
  'toBeTruthy',
]);

/** Fixtures and page.url() are never undefined/null/falsy. */
const ALWAYS_TRUTHY_FIXTURE = /^(?:page|context|browser|request|page\.url\(\))$/;
/**
 * Methods that return a Locator (a handle, not a query result). A chain made
 * only of these — `page.getByRole('x').first()` — is always defined; one that
 * ends in `.textContent()`, `.count()`, `.getAttribute()` is a real value.
 */
const LOCATOR_METHODS = new Set([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'frameLocator',
  'first',
  'last',
  'nth',
  'filter',
  'and',
  'or',
  'describe',
]);
const EXISTENCE_MATCHERS = new Set(['toBeDefined', 'toBeTruthy']);
const NEGATED_ABSENCE_MATCHERS = new Set(['toBeNull', 'toBeUndefined', 'toBeFalsy']);

/** A literal with nothing dynamic in it (template literals with `${` excluded). */
const LITERAL =
  /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)$/s;

/**
 * Decide whether `code` has at least one falsifiable assertion.
 */
export function lintAssertions(code: string): AssertionLintResult {
  const assertions = findAssertions(code);
  const vacuous: VacuousAssertion[] = [];
  let falsifiable = 0;

  for (const assertion of assertions) {
    const reason = vacuousReason(assertion);
    if (reason) vacuous.push({ snippet: assertion.snippet, reason });
    else falsifiable++;
  }

  if (assertions.length === 0) {
    return { ok: false, total: 0, vacuous, reason: 'no expect() assertion — the test cannot fail' };
  }
  if (falsifiable === 0) {
    const detail = vacuous.map((v) => `${v.snippet} (${v.reason})`).join('; ');
    return {
      ok: false,
      total: assertions.length,
      vacuous,
      reason: `every assertion is unfalsifiable — ${detail}`,
    };
  }
  return { ok: true, total: assertions.length, vacuous };
}

/**
 * Split generated tests into the ones worth running and the ones that could
 * never fail. Callers log and surface `rejected`; nothing in it reaches disk.
 */
export function rejectTautologies(tests: GeneratedTest[]): {
  kept: GeneratedTest[];
  rejected: RejectedTest[];
} {
  const kept: GeneratedTest[] = [];
  const rejected: RejectedTest[] = [];
  for (const test of tests) {
    const result = lintAssertions(test.code);
    if (result.ok) kept.push(test);
    else
      rejected.push({
        filename: test.filename,
        reason: result.reason ?? 'no falsifiable assertion',
      });
  }
  return { kept, rejected };
}

/** The PR-body section both report builders show for rejected tests. */
export function renderRejectedSection(rejected: RejectedTest[] | undefined): string {
  if (!rejected || rejected.length === 0) return '';
  let body = '### 🚫 Discarded: tests that could not fail\n\n';
  body +=
    'GreenCI checks every generated test for at least one assertion a real page could falsify. ' +
    'These had none, so they were not written — a test that is always green only inflates the count:\n\n';
  body += rejected.map((r) => `- \`${r.filename}\` — ${r.reason}`).join('\n') + '\n\n';
  return body;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** Characters after which a `/` starts a regex literal rather than division. */
const REGEX_PRECEDERS = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '\n',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/**
 * Index just past the `)` that closes the `(` at `open`, honouring strings,
 * template literals, regex literals and comments. Returns -1 when unbalanced.
 */
function closingParen(code: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      i = code.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i += 2;
      continue;
    }
    if (ch === '/' && startsRegex(code, i)) {
      i = skipRegex(code, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function skipString(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && code[i + 1] === '{') {
      const end = closingParen(code, i + 1);
      if (end < 0) return code.length;
      i = end;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return code.length;
}

function startsRegex(code: string, slash: number): boolean {
  let j = slash - 1;
  while (j >= 0 && (code[j] === ' ' || code[j] === '\t')) j--;
  if (j < 0) return true;
  return REGEX_PRECEDERS.has(code[j]);
}

function skipRegex(code: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return i; // not a regex after all; stop at line end
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i++;
      while (i < code.length && /[a-z]/i.test(code[i])) i++; // flags
      return i;
    }
    i++;
  }
  return code.length;
}

/**
 * Two views of the source: `code` with comments removed, and `mask`, the
 * same text with every string and regex body blanked to spaces. Indices line
 * up, so the scanner finds `expect(` in `mask` (never inside a string) and
 * reads subjects and arguments from `code`.
 */
function prepare(source: string): { code: string; mask: string } {
  let code = '';
  let mask = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(source, i);
      code += source.slice(i, end);
      mask += ch + ' '.repeat(Math.max(0, end - i - 2)) + (end - i > 1 ? ch : '');
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      code += ' ';
      mask += ' ';
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '/' && startsRegex(source, i)) {
      const end = skipRegex(source, i);
      code += source.slice(i, end);
      mask += ' '.repeat(end - i);
      i = end;
      continue;
    }
    code += ch;
    mask += ch;
    i++;
  }
  return { code, mask };
}

const EXPECT_CALL = /\bexpect(?:\s*\.\s*(?:soft|poll))?\s*\(/g;
const CHAIN_LINK = /\s*\.\s*([A-Za-z_$][\w$]*)/y;
const OPEN_PAREN = /\s*\(/y;

function findAssertions(source: string): ParsedAssertion[] {
  const out: ParsedAssertion[] = [];
  const { code, mask } = prepare(source);
  EXPECT_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPECT_CALL.exec(mask))) {
    const open = m.index + m[0].length - 1;
    const close = closingParen(code, open);
    if (close < 0) break;
    const subject = code.slice(open + 1, close - 1).trim();

    // Walk the chain: (.modifier)* .matcher( args )
    const modifiers: string[] = [];
    let matcher = '';
    let args = '';
    let i = close;
    let end = close;
    for (;;) {
      CHAIN_LINK.lastIndex = i;
      const link = CHAIN_LINK.exec(mask);
      if (!link) break;
      const name = link[1];
      const afterName = i + link[0].length;
      if (name === 'not' || name === 'resolves' || name === 'rejects') {
        modifiers.push(name);
        i = afterName;
        continue;
      }
      OPEN_PAREN.lastIndex = afterName;
      const paren = OPEN_PAREN.exec(mask);
      if (!paren) break;
      const argsOpen = afterName + paren[0].length - 1;
      const argsClose = closingParen(code, argsOpen);
      if (argsClose < 0) break;
      matcher = name;
      args = code.slice(argsOpen + 1, argsClose - 1).trim();
      end = argsClose;
      break;
    }

    out.push({
      subject,
      modifiers,
      matcher,
      args,
      snippet: code.slice(m.index, end).replace(/\s+/g, ' ').trim(),
    });
    EXPECT_CALL.lastIndex = Math.max(end, close);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function vacuousReason(a: ParsedAssertion): string | null {
  if (!a.matcher) return null; // unfinished chain — leave it to Playwright
  const negated = a.modifiers.includes('not');

  // expect(true).toBe(true): both sides are constants, so the outcome is too.
  // expect(200).toBe(response.status()) is backwards but real — keep it.
  if (LITERAL.test(a.subject) && (a.args === '' || LITERAL.test(a.args))) {
    return 'both sides are constants';
  }

  // Pattern matchers fed a pattern that matches anything.
  const isUrl = URL_MATCHERS.has(a.matcher);
  const isSubstring = SUBSTRING_MATCHERS.has(a.matcher);
  if (!negated && (isUrl || isSubstring || EXACT_TEXT_MATCHERS.has(a.matcher))) {
    const first = firstArgument(a.args);
    const probes = isUrl ? URL_PROBES : TEXT_PROBES;
    if (first !== null && matchesEverything(first, probes, isSubstring)) {
      return `${a.matcher}(${first}) matches any value`;
    }
  }

  // The document root is always visible/attached.
  if (!negated && ROOT_LOCATOR.test(a.subject) && EXISTENCE_MATCHERS_FOR_ROOT.has(a.matcher)) {
    return 'the document root is always rendered';
  }

  // Fixtures, locator handles and page.url() are never undefined/null/falsy.
  if (ALWAYS_TRUTHY_FIXTURE.test(a.subject) || isLocatorChain(a.subject)) {
    if (!negated && EXISTENCE_MATCHERS.has(a.matcher)) return 'subject is always defined';
    if (negated && NEGATED_ABSENCE_MATCHERS.has(a.matcher)) return 'subject is never null';
  }

  return null;
}

/**
 * `page.<locatorMethod>(...)(.<locatorMethod>(...))*` and nothing else: a
 * Locator handle. Any `await`, any other trailing call (`.count()`,
 * `.textContent()`), or anything after the chain means a real value.
 */
function isLocatorChain(subject: string): boolean {
  if (!subject.startsWith('page')) return false;
  let i = 'page'.length;
  let links = 0;
  while (i < subject.length) {
    CHAIN_LINK.lastIndex = i;
    const link = CHAIN_LINK.exec(subject);
    if (!link || !LOCATOR_METHODS.has(link[1])) return false;
    const afterName = i + link[0].length;
    OPEN_PAREN.lastIndex = afterName;
    const paren = OPEN_PAREN.exec(subject);
    if (!paren) return false;
    const close = closingParen(subject, afterName + paren[0].length - 1);
    if (close < 0) return false;
    i = close;
    links++;
  }
  return links > 0;
}

/** First top-level argument of an argument list, or null when empty. */
function firstArgument(args: string): string | null {
  if (!args) return null;
  let depth = 0;
  let i = 0;
  while (i < args.length) {
    const ch = args[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(args, i);
      continue;
    }
    if (ch === '/' && startsRegex(args, i)) {
      i = skipRegex(args, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) return args.slice(0, i).trim();
    i++;
  }
  return args.trim();
}

function isEmptyString(arg: string | null): boolean {
  return arg !== null && /^(['"`])\1$/.test(arg);
}

/**
 * True when `arg` is a pattern every probe satisfies: a regex literal that
 * accepts all of them, an empty string (substring of everything), or an
 * `expect.anything()` / `expect.any(String)` wildcard.
 */
function matchesEverything(arg: string, probes: string[], emptyStringIsWildcard: boolean): boolean {
  if (isEmptyString(arg)) return emptyStringIsWildcard;
  if (/^expect\.(anything\(\)|any\(\s*String\s*\))$/.test(arg)) return true;
  const re = /^\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/])*)\/([a-z]*)$/s.exec(arg);
  if (!re) return false;
  let pattern: RegExp;
  try {
    // g and y make .test() stateful across probes; they do not change what matches.
    pattern = new RegExp(re[1], re[2].replace(/[^imsu]/g, ''));
  } catch {
    return false;
  }
  return probes.every((p) => pattern.test(p));
}
