import { useEffect, useRef, useState } from 'react';
import { useTheme } from '@d3cloud/ui';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import mermaid from 'mermaid';

/**
 * Markdown, rendered — with Mermaid diagrams (FRM-REQ-066).
 *
 * Three decisions:
 *
 * 1. **Sanitised, always.** The prose is written by the one operator, so this is not a defence
 *    against a hostile author — it is a defence against a document *imported* from the vault,
 *    where a stray `<script>` in a code sample would otherwise run inside the console's origin,
 *    which holds the session cookie.
 * 2. **Mermaid is loaded with the page, not lazily.** The console is desktop-only and
 *    single-operator; a spinner on every architecture document buys nothing.
 * 3. **A diagram that will not parse renders as its source**, with the parser's complaint. A blank
 *    space where a diagram should be is the failure that gets shipped.
 * 4. **A diagram follows the theme after it is drawn.** Mermaid bakes its palette into the SVG at
 *    render time, so a diagram drawn in light mode stays light when the theme flips — pale edge
 *    labels on pale plates, failing contrast. The theme is a dependency of the drawing, and a
 *    change redraws.
 */

/** The theme Mermaid was last initialised with. It is one global configuration for the page. */
let initialisedFor: boolean | null = null;

function initMermaid(dark: boolean): void {
  if (initialisedFor === dark) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  initialisedFor = dark;
}

/**
 * A page-unique id per drawing. `mermaid.render` removes whatever element already holds the id it
 * is given, and a theme change redraws every diagram on the page in the same tick — so an id built
 * from the slot index and `Date.now()` could collide across two sections and delete one's diagram.
 */
let drawings = 0;

/** Pull the mermaid fences out, leaving placeholders the renderer fills in. */
function split(markdown: string): { text: string; diagrams: string[] } {
  const diagrams: string[] = [];
  const text = markdown.replace(/```mermaid\s*\n([\s\S]*?)```/g, (_match, body: string) => {
    diagrams.push(body.trim());
    return `\n<div data-mermaid="${String(diagrams.length - 1)}"></div>\n`;
  });
  return { text, diagrams };
}

export function Markdown({ children }: { children: string }) {
  const host = useRef<HTMLDivElement>(null);
  // `resolved`, not `preference`: `system` is followed live through `prefers-color-scheme` by the
  // provider, so this one value changes for the ThemeSwitch and for the OS alike.
  const dark = useTheme().resolved === 'dark';
  const [rendered, setRendered] = useState<{ html: string; diagrams: string[] }>({
    html: '',
    diagrams: [],
  });

  useEffect(() => {
    const { text, diagrams } = split(children);
    const parsed = marked.parse(text, { async: false, gfm: true, breaks: false });
    // `data-mermaid` must survive the sanitiser, or the placeholders are unreachable.
    const html = DOMPurify.sanitize(parsed, { ADD_ATTR: ['data-mermaid'] });
    setRendered({ html, diagrams });
  }, [children]);

  /**
   * Diagrams are drawn in their own effect, keyed on the rendered HTML.
   *
   * The first version drew them in a microtask queued from the effect above, which usually ran
   * *before* React committed the new HTML — so `querySelector` found no placeholder and the
   * diagram silently never appeared. An effect that depends on the HTML runs after it is in the
   * DOM, which is the only ordering that is actually guaranteed.
   *
   * It is keyed on the theme too, and redraws into the same slots when the theme changes. Reading
   * `data-theme` from `<html>` once, at first draw, is what left every diagram in its old palette.
   */
  useEffect(() => {
    if (rendered.diagrams.length === 0) return;
    const root = host.current;
    if (root === null) return;

    // An AbortController rather than a boolean: rendering a diagram is asynchronous, and a render
    // that finishes after the section changed must not paint over what replaced it.
    const cancel = new AbortController();
    initMermaid(dark);

    void (async () => {
      for (const [index, source] of rendered.diagrams.entries()) {
        const slot = root.querySelector(`[data-mermaid="${String(index)}"]`);
        if (slot === null) continue;
        try {
          drawings += 1;
          const { svg } = await mermaid.render(`fm-mermaid-${String(drawings)}`, source);
          if (!cancel.signal.aborted) slot.innerHTML = svg;
        } catch (error) {
          if (cancel.signal.aborted) return;
          // The source and the complaint, not an empty box: a diagram that silently vanished is
          // one nobody notices is broken.
          const message = error instanceof Error ? error.message : String(error);
          const pre = window.document.createElement('pre');
          pre.className = 'fm-mermaid-error';
          pre.textContent = `${message}\n\n${source}`;
          slot.replaceChildren(pre);
        }
      }
    })();

    return () => {
      cancel.abort();
    };
  }, [rendered, dark]);

  return (
    <div
      ref={host}
      className="fm-markdown"
      // Sanitised in the effect above, and the only path by which content reaches this.
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
