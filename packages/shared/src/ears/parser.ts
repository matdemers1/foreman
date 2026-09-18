import type { EarsPattern } from '../enums.js';

/**
 * The EARS parser (T-3.2, FRM-REQ-050).
 *
 * EARS — Easy Approach to Requirements Syntax — has five shapes plus a complex combination:
 *
 * | Pattern | Shape |
 * |---|---|
 * | ubiquitous | `<system> <response>` — unconditional |
 * | state | **While** `<state>`, `<system> <response>` |
 * | event | **When** `<trigger>`, `<system> <response>` |
 * | unwanted | **If** `<condition>`, **then** `<system> <response>` |
 * | optional | **Where** `<feature>`, `<system> <response>` |
 * | complex | a state clause and an event clause together |
 *
 * ## What it does not require, and why
 *
 * **It does not require "shall".** The first version did, and measured against the real corpus it
 * warned on **57%** of 591 requirements — including **100% of Bindery's 210 and 100% of Burrow's
 * 85**, because both registers are written in the present indicative: "Original bytes are stored
 * content-addressed by SHA-256". That is a ubiquitous requirement in substance. Only 1 of those 295
 * statements uses a modal at all.
 *
 * A lint that fires on every line of two projects is noise, and noise teaches people to ignore the
 * warnings that matter — which is the exact failure the "warn, never reject" rule exists to avoid.
 * So the modal is **recorded, not demanded**: `modal` says whether the obligation is explicit, and
 * a register written in the indicative is a stylistic choice rather than a defect.
 *
 * ## What it does warn about
 *
 * Only things that are checkable and worth a person's attention:
 *
 * 1. **No predicate at all** — "Device Authorization Grant (RFC 8628)", "Per-user recovery codes",
 *    "Supported input types: PDF, JPEG, PNG". These name a feature; they do not state a behaviour,
 *    so nothing can be tested against them. This is the warning that earns the lint its keep.
 * 2. **A conditional clause that is malformed** — `While` or `When` with no comma to close the
 *    clause, `If` with no `then`.
 * 3. **More than one obligation in one statement** — "the system shall X and shall Y" is two
 *    requirements wearing one ID, and only one of them will get a test.
 *
 * English is not parsed here, and pretending otherwise would produce confident nonsense. Finding a
 * predicate is done with a lexicon of auxiliaries plus the verbs that actually occur in requirement
 * writing, tuned against those 591 statements and listed below so it can be extended on evidence.
 */

/** Auxiliaries and modals. Any of these is a finite verb on its own. */
const AUXILIARIES = [
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had',
  'does', 'do', 'did',
  'shall', 'must', 'will', 'should', 'may', 'might', 'can', 'could', 'would',
  // One word, and a very common way to state a prohibition: "an administrator cannot read…".
  'cannot',
] as const;

/**
 * Verbs that carry a requirement's behaviour. Third-person singular, because that is the form a
 * requirement written in the indicative uses: "the system **stores**".
 *
 * Derived from the corpus rather than from a dictionary — a plural noun ending in `-s` is
 * indistinguishable from a verb without a part-of-speech tagger, so the safe move is to name the
 * verbs rather than guess at the nouns.
 */
const VERBS = [
  'accepts', 'adds', 'allows', 'answers', 'applies', 'appears', 'asks', 'attributes',
  'blocks', 'builds', 'calls', 'captures', 'carries', 'checks', 'clears', 'closes', 'counts',
  'creates', 'declares', 'defaults', 'defines', 'deletes', 'derives', 'detects', 'disables',
  'displays', 'drops', 'enables', 'encrypts', 'ends', 'enforces', 'ensures', 'exists', 'expires',
  'exports', 'exposes', 'fails', 'falls', 'filters', 'finds', 'follows', 'generates', 'grants',
  'groups', 'handles', 'hides', 'holds', 'identifies', 'ignores', 'imports', 'includes',
  'ingests', 'keeps', 'lands', 'lists', 'loads', 'logs', 'maps', 'marks', 'matches', 'moves',
  'names', 'offers', 'opens', 'orders', 'performs', 'persists', 'prevents', 'produces',
  'prompts', 'provides', 'provisions', 'publishes', 'reads', 'rebuilds', 'receives', 'recognises', 'recognizes',
  'records', 'recovers', 'refuses', 'rejects', 'removes', 'renders', 'renews', 'replicates',
  'reports', 'requires', 'resolves', 'restores', 'retains', 'returns', 'reveals', 'raises',
  'runs', 'saves', 'scrubs', 'sends', 'serves', 'sets', 'shows', 'signs', 'sorts', 'starts',
  'stays', 'stops', 'stores', 'supports', 'surfaces', 'takes', 'tracks', 'treats', 'triggers',
  'updates', 'uses', 'validates', 'verifies', 'waits', 'warns', 'works', 'writes',
] as const;

/**
 * Base-form verbs. Two moods need them, so they are recognised anywhere in the statement:
 *
 * - **the imperative**, which is Burrow's house style throughout — "Authenticate via OAuth",
 *   "Prune read-state older than 90 days";
 * - **a plural subject**, which takes the base form in the present tense — "Heuristic proposers
 *   **detect** candidate boundaries", "Saved searches **persist** as smart shelves".
 *
 * Matching them anywhere costs precision: "support" and "sort" are nouns as often as verbs, so a
 * statement like "Subreddit screen: feed + header chip row (… · sort)" now passes the predicate
 * check when it should not. That trade is taken deliberately. A missed warning costs one
 * requirement nobody was told about; a spurious one teaches the reader that the lint is noise, and
 * then every real warning is lost with it.
 */
const IMPERATIVES = [
  'accept', 'add', 'allow', 'answer', 'apply', 'authenticate', 'block', 'build', 'cache',
  'capture', 'carry', 'check', 'clear', 'close', 'count', 'create', 'decode', 'define', 'delete',
  'derive', 'detect', 'dim', 'disable', 'display', 'drop', 'enable', 'encrypt', 'end', 'enforce',
  'ensure', 'expire', 'export', 'expose', 'filter', 'find', 'generate', 'grant', 'group',
  'handle', 'hide', 'hold', 'identify', 'ignore', 'import', 'include', 'ingest', 'keep', 'let',
  'list', 'load', 'log', 'map', 'mark', 'match', 'move', 'name', 'offer', 'open', 'order',
  'paint', 'perform', 'persist', 'prevent', 'produce', 'prompt', 'prune', 'provide', 'publish',
  'read', 'rebuild', 'receive', 'record', 'recover', 'refuse', 'reject', 'relaunch', 'remember',
  'remove', 'render', 'renew', 'replicate', 'report', 'require', 'resolve', 'restore', 'retain',
  'return', 'reveal', 'run', 'save', 'scrub', 'send', 'serve', 'set', 'show', 'sign', 'sort',
  'start', 'stop', 'store', 'support', 'surface', 'take', 'track', 'treat', 'trigger', 'update',
  'use', 'validate', 'verify', 'wait', 'warn', 'write',
  // Added after measuring: each appeared in the corpus with a plural subject or in the imperative.
  'deploy', 'persist', 'provision', 'rotate', 'redact', 'collapse', 'vote', 'scroll',
] as const;

/**
 * A constraint stated as an absence — "No telemetry or analytics", "Never stores the plaintext".
 * A prohibition is a requirement, and it is testable precisely because it forbids something.
 */
const PROHIBITION_RE = /^\s*(?:no|never|nothing)\b/i;

const AUXILIARY_RE = new RegExp(`\\b(?:${AUXILIARIES.join('|')})\\b`, 'i');
/**
 * Base forms, matched **lower-case only** away from the start of the statement.
 *
 * Case is the cheap signal that separates the verb from the proper noun: "Heuristic proposers
 * **detect** boundaries" is a behaviour, "Device Authorization **Grant** (RFC 8628)" is a name. At
 * position 0 the match is case-insensitive, because that is where sentence capitalisation lives.
 */
const IMPERATIVE_LEAD_RE = new RegExp(`^\\s*[*\`"']*(?:${IMPERATIVES.join('|')})\\b`, 'i');
const IMPERATIVE_MID_RE = new RegExp(`\\b(?:${IMPERATIVES.join('|')})\\b`);
const VERB_RE = new RegExp(`\\b(?:${VERBS.join('|')})\\b`, 'i');
const MODAL_RE = /\b(?:shall|must|will|should)\b/i;

/** A past participle used as a passive predicate: "bytes **are stored**" is caught by `are`. */
const WHILE_RE = /^\s*while\b/i;
const WHEN_RE = /^\s*when\b/i;
const IF_RE = /^\s*if\b/i;
const THEN_RE = /\bthen\b/i;
const WHERE_RE = /^\s*where\b/i;
const MID_WHEN_RE = /,\s*when\b/i;

export type Modal = 'explicit' | 'implicit';

export interface EarsParse {
  readonly pattern: EarsPattern;
  /** False only for the three defects above. A stylistic difference is not a failure. */
  readonly ok: boolean;
  /**
   * `explicit` when the statement says "shall" or "must"; `implicit` when the obligation is in the
   * indicative mood, which most of the real corpus uses. Recorded, never demanded.
   */
  readonly modal: Modal;
  /** Present when `ok` is false. Always says what to do, not only what is wrong. */
  readonly note?: string;
}

/** Is there a finite verb — anything that states a behaviour rather than naming a thing? */
export function hasPredicate(statement: string): boolean {
  // The lexicons are checked against the prose only: a statement whose only verb-like word is
  // inside `code` or a parenthesised citation is still just a name.
  const prose = statement
    .replace(/`[^`]*`/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*\*/g, '');
  // Three moods, all legitimate: indicative ("the system stores"), imperative ("Store…"), and the
  // prohibition ("No telemetry"). A register picks one and keeps to it.
  return (
    AUXILIARY_RE.test(prose) ||
    VERB_RE.test(prose) ||
    IMPERATIVE_LEAD_RE.test(prose) ||
    IMPERATIVE_MID_RE.test(prose) ||
    PROHIBITION_RE.test(prose)
  );
}

/**
 * Parse a statement. **Never throws, and never rejects** — the worst outcome is `unparsed` with a
 * note, which is a legal stored state (FRM-REQ-051, FRM-REQ-052).
 */
export function parseEars(statement: string): EarsParse {
  const text = statement.trim();
  const modal: Modal = MODAL_RE.test(text) ? 'explicit' : 'implicit';

  if (text.length === 0) {
    return { pattern: 'unparsed', ok: false, modal, note: 'the statement is empty' };
  }

  // A name is not a requirement. This is the warning worth having: nothing can be tested against
  // "Per-user recovery codes", and nobody notices it is missing until the phase will not close.
  if (!hasPredicate(text)) {
    return {
      pattern: 'unparsed',
      ok: false,
      modal,
      note: 'this names a feature rather than stating a behaviour — say what the system does, so there is something to test',
    };
  }

  // Two obligations in one statement is two requirements sharing one ID, and only one of them
  // will get a test written for it.
  const modalCount = (text.match(/\b(?:shall|must)\b/gi) ?? []).length;
  if (modalCount > 1) {
    return {
      pattern: patternOf(text),
      ok: false,
      modal,
      note: 'this states more than one obligation — split it, or only one of them will be tested',
    };
  }

  const hasWhile = WHILE_RE.test(text);
  const hasWhen = WHEN_RE.test(text) || MID_WHEN_RE.test(text);

  if (hasWhile && hasWhen) return { pattern: 'complex', ok: true, modal };
  if (hasWhile) return clauseCheck(text, 'state', 'While', modal);
  if (WHEN_RE.test(text)) return clauseCheck(text, 'event', 'When', modal);

  if (IF_RE.test(text)) {
    if (!THEN_RE.test(text)) {
      return {
        pattern: 'unwanted',
        ok: false,
        modal,
        note: 'an "If" requirement needs its "then": "If <condition>, then <the system> <response>"',
      };
    }
    return { pattern: 'unwanted', ok: true, modal };
  }

  if (WHERE_RE.test(text)) return clauseCheck(text, 'optional', 'Where', modal);

  // No leading keyword, and it states a behaviour: an unconditional requirement.
  return { pattern: 'ubiquitous', ok: true, modal };
}

function patternOf(text: string): EarsPattern {
  if (WHILE_RE.test(text) && MID_WHEN_RE.test(text)) return 'complex';
  if (WHILE_RE.test(text)) return 'state';
  if (WHEN_RE.test(text)) return 'event';
  if (IF_RE.test(text)) return 'unwanted';
  if (WHERE_RE.test(text)) return 'optional';
  return 'ubiquitous';
}

function clauseCheck(
  text: string,
  pattern: EarsPattern,
  keyword: string,
  modal: Modal,
): EarsParse {
  if (!text.includes(',')) {
    return {
      pattern,
      ok: false,
      modal,
      note: `a "${keyword}" requirement separates its clause with a comma: "${keyword} <clause>, <the system> <response>"`,
    };
  }
  return { pattern, ok: true, modal };
}

/** The verbs and auxiliaries the predicate check knows, for the test that keeps them honest. */
export const LEXICON = { AUXILIARIES, VERBS, IMPERATIVES } as const;
