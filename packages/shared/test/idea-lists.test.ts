import { describe, expect, it } from 'vitest';
import { parseIdeaList } from '../src/index.js';

/**
 * Lines of text into the canvas's lists (FRM-ADR-017).
 *
 * The input is a person's or a model's list, written the way lists are written: with bullets,
 * numbers, Markdown checkboxes, commas between tags. Refusing `- ` in front of a question would be
 * refusing the most common way anyone writes one.
 */
describe('parseIdeaList', () => {
  it('takes a checklist in any of the usual shapes, and honours [x]', () => {
    const items = parseIdeaList(
      'questions',
      '- Does LAN mode expose progress?\n* Is SMS the right channel?\n3. What does it cost?\n[x] Is there an API?\n\n',
    );
    expect(items).toEqual([
      expect.objectContaining({ text: 'Does LAN mode expose progress?', done: false }),
      expect.objectContaining({ text: 'Is SMS the right channel?', done: false }),
      expect.objectContaining({ text: 'What does it cost?', done: false }),
      expect.objectContaining({ text: 'Is there an API?', done: true }),
    ]);
  });

  it('gives every item an id, the same one each time for the same text', () => {
    const once = parseIdeaList('nextSteps', 'Capture a night of messages');
    const again = parseIdeaList('nextSteps', 'Capture a night of messages');
    // Deterministic, so re-sending the same list does not churn every id and every audit diff.
    expect(once[0]).toHaveProperty('id');
    expect(once).toEqual(again);
  });

  it('reads links as Markdown, as label | url, or bare', () => {
    const links = parseIdeaList(
      'links',
      '[Home Assistant](https://example.com/ha)\nBambu docs | https://example.com/bambu\nhttps://example.com/raw',
    );
    expect(
      links.map((l) => (typeof l === 'object' && 'label' in l ? [l.label, l.url] : [])),
    ).toEqual([
      ['Home Assistant', 'https://example.com/ha'],
      ['Bambu docs', 'https://example.com/bambu'],
      ['https://example.com/raw', 'https://example.com/raw'],
    ]);
  });

  it('splits tags and related IDs on commas as well as lines, and normalises them', () => {
    expect(parseIdeaList('tags', 'Home Lab, hardware\nAI')).toEqual(['home-lab', 'hardware', 'ai']);
    expect(parseIdeaList('related', 'bnd, pi-003\nauth-req-012')).toEqual(['BND', 'PI-003', 'AUTH-REQ-012']);
  });
});
