/**
 * @d3cloud/foreman-mcp — the stdio shim (ADR-003).
 *
 * Tools and resources land in later phases; the package exists from Phase 0 so `packages/shared`
 * has a third consumer from the first day and the contract tests have somewhere to live.
 */
export const MCP_SPEC_VERSION = '2026-07-28';

/** The hard ceiling asserted by a contract test: at most 12 tools, total (FRM-REQ-081 neighbourhood). */
export const MAX_TOOLS = 12;
