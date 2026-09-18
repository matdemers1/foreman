import { basename, dirname } from 'node:path';

/**
 * What kind of file is this? (T-8.3)
 *
 * Classification happens before mapping so that **every file gets an outcome**, including the ones
 * nothing knows how to read. The importer's whole contract is that silence is the failure mode
 * (FRM-REQ-148): a file the importer cannot classify is `unmapped` *with a reason*, never absent
 * from the report.
 */

export type FileKind =
  | 'requirements-register'
  | 'scope-of-work'
  | 'adr'
  | 'phase-plan'
  | 'finding'
  | 'audit-summary'
  | 'risk-register'
  | 'glossary'
  | 'document'
  | 'project-overview'
  | 'unknown';

export interface Classification {
  readonly kind: FileKind;
  /** Why, in words — it goes in the reconciliation report beside the file. */
  readonly because: string;
}

/** The document kinds a generic `document` may carry, by filename. */
const DOCUMENT_KINDS: Record<string, string> = {
  architecture: 'architecture',
  'data model': 'data_model',
  'api contract': 'api_contract',
  'ux flows & screen inventory': 'ux_flows',
  'ux flows': 'ux_flows',
  research: 'research',
  'discovery & requirements': 'discovery',
  'test strategy': 'test_strategy',
  'feature ideas & future development': 'feature_ideas',
  'feature ideas': 'feature_ideas',
};

export function documentKindFor(name: string): string | null {
  return DOCUMENT_KINDS[name.replace(/\.md$/i, '').toLowerCase()] ?? null;
}

export function classify(path: string, frontmatter: Record<string, unknown>): Classification {
  const name = basename(path).replace(/\.md$/i, '');
  const lower = name.toLowerCase();
  const folder = basename(dirname(path)).toLowerCase();
  const tags = Array.isArray(frontmatter['tags']) ? (frontmatter['tags'] as string[]) : [];

  // A finding carries its own id in frontmatter — the most reliable signal in the corpus.
  if (typeof frontmatter['finding_id'] === 'string') {
    return { kind: 'finding', because: 'frontmatter carries a finding_id' };
  }
  if (folder === 'findings') {
    return { kind: 'finding', because: 'it sits in a Findings folder' };
  }
  // A design audit writes `D-01 — …`, a feature review `T-01 — …`, a code review `CR-014 — …`.
  // Under an Audits tree, that prefix is a finding ID rather than a coincidence.
  if (/\/Audits\//.test(path) && /^(?:CR|DA|FR|API|D|T|R)-\d+\s*—/i.test(name)) {
    return { kind: 'finding', because: 'an audit finding, by its ID prefix' };
  }

  if (/^adr-\d+/i.test(name)) return { kind: 'adr', because: 'the filename is an ADR number' };
  if (tags.includes('type/adr')) return { kind: 'adr', because: 'tagged type/adr' };

  if (lower === 'requirements register') {
    return { kind: 'requirements-register', because: 'the register filename' };
  }
  if (lower === 'scope of work') {
    return { kind: 'scope-of-work', because: 'the scope-of-work filename' };
  }
  if (lower === 'risk register') {
    return { kind: 'risk-register', because: 'the risk-register filename' };
  }
  if (lower === 'glossary') return { kind: 'glossary', because: 'the glossary filename' };

  if (folder === 'phase plans' || /^phase \d/i.test(name)) {
    return { kind: 'phase-plan', because: 'it is a phase plan' };
  }
  if (/^\d+ — summary$/i.test(lower) || lower === '_audit index' || /^appendix\b/i.test(lower)) {
    return { kind: 'audit-summary', because: 'an audit summary, index or appendix' };
  }

  if (documentKindFor(name) !== null) {
    return { kind: 'document', because: `a ${documentKindFor(name) ?? ''} document` };
  }
  if (/overview$/i.test(lower)) {
    return { kind: 'project-overview', because: 'a project overview' };
  }

  /**
   * Everything else authored is a document.
   *
   * The first version returned `unknown` here, and 171 of 535 real files came back unmapped —
   * research notes, discovery roadmaps, business plans, every design-audit idea. All of them are
   * prose somebody wrote, and a report calling a third of the vault unreadable is a report that
   * says the importer does not work.
   *
   * `unknown` now means what it should: the file was read and **nothing was found in it**. That
   * decision is made by the mapper, which can see whether there were any headings, not here.
   */
  return {
    kind: 'document',
    because: 'authored prose with no typed kind — stored as a research document',
  };
}
