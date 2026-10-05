import { Button } from '@d3cloud/ui';
import { Smartphone } from 'lucide-react';

/**
 * "Open in D3 Constellation" (FRM-T-15.1): the same item in the native app, by a
 * `d3constellation://<host>/foreman/<path>` link — the host picks the connection there, so the link
 * never crosses servers. The app opens a project's brief, and an item's through its human ID.
 *
 * Offered only on Apple devices, the only place the app exists; iPadOS Safari calls itself a Mac.
 */
export function constellationLink(path: string, host: string = window.location.host): string {
  return `d3constellation://${host}/foreman/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const onApple = () => typeof navigator !== 'undefined' && /iPhone|iPad|Macintosh/.test(navigator.userAgent);

export function OpenInConstellation({ path }: { path: string }) {
  if (!onApple()) return null;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon={<Smartphone />}
      onClick={() => {
        window.location.href = constellationLink(path);
      }}
    >
      Open in D3 Constellation
    </Button>
  );
}
