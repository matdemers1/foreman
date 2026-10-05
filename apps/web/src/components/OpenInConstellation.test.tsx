import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { constellationLink, OpenInConstellation } from './OpenInConstellation';

/** FRM-T-15.1: the link D3 Constellation opens, and the action offered only where the app exists. */
describe('Open in D3 Constellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names this host and Foreman, so the app opens the item on the same connection', () => {
    expect(constellationLink('item/FRM-T-15.1', 'foreman.d3cloud.io')).toBe('d3constellation://foreman.d3cloud.io/foreman/item/FRM-T-15.1');
    expect(constellationLink('document/BND/architecture', 'foreman.d3cloud.io')).toBe(
      'd3constellation://foreman.d3cloud.io/foreman/document/BND/architecture',
    );
    expect(constellationLink('item/a b', 'foreman.d3cloud.io')).toBe('d3constellation://foreman.d3cloud.io/foreman/item/a%20b');
  });

  it('is offered on an iPhone and not on Windows', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)' });
    expect(renderToStaticMarkup(<OpenInConstellation path="project/FRM" />)).toContain('Open in D3 Constellation');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(renderToStaticMarkup(<OpenInConstellation path="project/FRM" />)).toBe('');
  });
});
