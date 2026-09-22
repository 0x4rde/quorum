/**
 * Little-endian 64-bit reads and writes that work in a browser.
 *
 * `Buffer` in the browser is a polyfill, and it does not carry Node's BigInt
 * accessors: `writeBigUInt64LE`, `readBigUInt64LE` and `readBigInt64LE` are
 * all absent. Code that uses them typechecks against Node's `@types/node`,
 * passes every test under `node --test`, builds without complaint, and then
 * throws `t.writeBigUInt64LE is not a function` the first time a real user
 * clicks a button. It is the exact shape of bug that only a browser finds.
 *
 * `DataView` has the same accessors, is part of the language rather than of
 * Node, and needs no polyfill. Everything on the client goes through here.
 *
 * `tests/frontend_parity.test.ts` deletes the Buffer methods and rebuilds the
 * instructions to prove nothing has crept back in.
 */

/** A u64 as eight little-endian bytes. */
export function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

/** Read a little-endian u64. */
export function readU64LE(data: Uint8Array, offset: number): bigint {
  return view(data).getBigUint64(offset, true);
}

/** Read a little-endian i64. */
export function readI64LE(data: Uint8Array, offset: number): bigint {
  return view(data).getBigInt64(offset, true);
}

/** Read a little-endian i32. */
export function readI32LE(data: Uint8Array, offset: number): number {
  return view(data).getInt32(offset, true);
}

/** Join byte arrays without going through `Buffer.concat`. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
