// Bundles a default "Private sites" list into extension/data/sensitive-sites.js, from a file of
// domains you provide (one per line; "#" comments and "*." / "www." prefixes are fine).
// Hackie ships with this list empty; users add their own sites in Settings → Private sites.
//
//   node tools/update-sensitive-list.mjs path/to/domains.txt
//
// Pages on these domains (or proxies to them) are never described to the AI judge.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'data', 'sensitive-sites.js');
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/update-sensitive-list.mjs path/to/domains.txt');
  process.exit(2);
}
const domains = [
  ...new Set(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, ''))
      .filter((l) => l && !l.startsWith('#') && DOMAIN.test(l)),
  ),
].sort();

if (!domains.length) throw new Error('No domains found in that file; refusing to overwrite.');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// Default "Private sites" list, bundled by tools/update-sensitive-list.mjs on ${new Date().toISOString().slice(0, 10)}.
// ${domains.length} domains. Pages on these sites, or proxies to them, are never described to the AI judge.
export const SENSITIVE_DOMAINS = ${JSON.stringify(domains)};
`,
);
console.log(`wrote ${domains.length} domains to ${OUT}`);
