// FRM-T-13.1: the Foreman mark — "True north", from the product marks on d3cloud.io (DI-REQ-040).
// Every D3 Cloud product keeps the planisphere's ring; inside it Foreman draws a compass needle whose
// tip is the one lit star. Ink is currentColor, so the mark takes the text colour in either theme;
// the star is the only colour. public/favicon.svg is the same drawing with the ink fixed per scheme.

export const FOREMAN_MARK_NAME = 'Foreman';

// d3-allow: the product's lit star from d3cloud.io (DI-REQ-040) — a brand constant shared with the site and the favicon, not a theme colour
export const FOREMAN_STAR = '#F2937A';

export interface ForemanMarkProps {
  /** Rendered width and height in px. */
  size?: number;
  /**
   * Set when the word "Foreman" is written beside the mark, so a screen reader does not read it
   * twice. Left off, the mark stands alone and is announced as an image named "Foreman".
   */
  decorative?: boolean;
  className?: string;
}

export function ForemanMark({ size = 20, decorative = false, className }: ForemanMarkProps) {
  // The site's two weights: finer lines at display sizes, heavier at icon sizes.
  const display = size >= 72;
  const w = display ? 2.2 : 3.5;
  const joint = display ? 2.6 : 3.4;
  const lit = display ? 4.4 : 5.5;
  const ink = {
    stroke: 'currentColor',
    strokeWidth: w,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      focusable="false"
      className={className}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': FOREMAN_MARK_NAME })}
    >
      <circle cx="32" cy="32" r="26" {...ink} />
      <path d="M32 12 L38 32 L32 52 L26 32 Z" {...ink} />
      <circle cx="32" cy="52" r={joint} fill="currentColor" />
      <circle cx="32" cy="12" r={lit} style={{ fill: FOREMAN_STAR }} />
    </svg>
  );
}
