/**
 * Node-only APIs must not appear in code the browser runs.
 *
 * I have now shipped the same bug twice: `Buffer` in the browser is a
 * polyfill without Node's BigInt accessors, so `writeBigUInt64LE` and
 * friends throw the first time a user clicks a button, while typechecking
 * cleanly against `@types/node` and passing every test. The first fix added
 * a behavioural test around the instruction builders; the bug came straight
 * back in a new file the test did not know about.
 *
 * So this one is structural rather than behavioural. It reads the source of
 * everything that reaches the browser and fails on the forbidden calls
 * wherever they are, including in files that did not exist when it was
 * written. That is the property the earlier test lacked.
 *
 * API routes under `src/app/api` are exempt: they run in Node, where those
 * methods are real.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'frontend/src';
const SERVER_ONLY = join('frontend', 'src', 'app', 'api');

/** Node `Buffer` methods with no counterpart in the browser polyfill. */
const FORBIDDEN = [
  'writeBigUInt64LE',
  'writeBigInt64LE',
  'readBigUInt64LE',
  'readBigInt64LE',
  'writeBigUInt64BE',
  'readBigUInt64BE',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('browser code avoids Node-only APIs', () => {
  it('never calls a Buffer BigInt accessor outside an API route', () => {
    const offences: string[] = [];

    for (const file of sourceFiles(ROOT)) {
      if (file.startsWith(SERVER_ONLY)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Skip prose: these names are named in comments explaining the rule.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const method of FORBIDDEN) {
          if (code.includes(`.${method}(`)) {
            offences.push(`${relative('.', file)}:${i + 1}  ${line.trim()}`);
          }
        }
      });
    }

    assert.deepEqual(
      offences,
      [],
      `Node-only Buffer methods in browser code. Use frontend/src/lib/bytes.ts, ` +
        `which uses DataView:\n  ${offences.join('\n  ')}`,
    );
  });

  it('scans a meaningful number of files, so a silent miss is visible', () => {
    const scanned = sourceFiles(ROOT).filter((f) => !f.startsWith(SERVER_ONLY));
    assert.ok(scanned.length >= 10, `only ${scanned.length} files scanned; is the path right?`);
  });
});
