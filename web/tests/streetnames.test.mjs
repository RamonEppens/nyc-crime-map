// The browser's street-name key must match the pipeline's for every shared case.
// Usage: node tests/streetnames.test.mjs   (the pipeline side: pipeline/tests/test_streetnames.py)
import { readFileSync } from 'node:fs';
import { clave } from '../src/streetnames.js';

const { cases } = JSON.parse(readFileSync(new URL('../../config/street_name_cases.json', import.meta.url)));
const bad = cases.filter(([input, want]) => clave(input) !== want);
for (const [input, want] of bad) console.error(`clave(${JSON.stringify(input)}) = ${JSON.stringify(clave(input))}, want ${JSON.stringify(want)}`);
console.log(`${cases.length - bad.length}/${cases.length} street-name cases pass`);
process.exit(bad.length ? 1 : 0);
