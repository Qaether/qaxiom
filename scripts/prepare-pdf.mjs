import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Bundled resources only: never fetch document fonts/code from a third-party CDN.
const source = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const destination = new URL('../public/pdfjs/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'LICENSE']) {
  await cp(fileURLToPath(new URL(name, source)), fileURLToPath(new URL(name, destination)), { recursive: true });
}
