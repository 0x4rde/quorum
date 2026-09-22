/**
 * Borsh encoding and PDA derivation for the Quorum program.
 *
 * There is no generated client: the program is small enough that hand-written
 * encoders are shorter than an IDL pipeline, and they are the same few bytes
 * the tests already assert against. This file is the single definition, shared
 * by `tests/helpers.ts` and the operational scripts, so a layout change cannot
 * be fixed in one place and missed in the other.
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('3Awpi9YyDb4432qSiBLGN9PkiSRvFYKjmpNYxy1BuRoi');
export const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

/** Anchor's 8-byte instruction discriminator. */
export function ixDisc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor's 8-byte account discriminator. */
export function acctDisc(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

// --- little-endian writers -------------------------------------------------
export const u8b = (n: number) => Buffer.from([n]);
export const u16b = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
export const u32b = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const i32b = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
export const u64b = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const i64b = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
export const u128b = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(n >> 64n, 8); return b; };
export const strb = (s: string) => Buffer.concat([u32b(Buffer.byteLength(s)), Buffer.from(s)]);

/** A 32-byte Pyth feed id from its hex form, with or without `0x`. */
export const feedIdBytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');

export const SEEDS = {
  vault: (symbol: string) =>
    PublicKey.findProgramAddressSync([Buffer.from('vault'), Buffer.from(symbol)], PROGRAM_ID)[0],
  indexMint: (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('index_mint'), vault.toBuffer()], PROGRAM_ID)[0],
  wrapper: (vault: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('wrapper'), vault.toBuffer(), mint.toBuffer()],
      PROGRAM_ID,
    )[0],
  swapTicket: (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('swap_ticket'), vault.toBuffer()], PROGRAM_ID)[0],
  vaultToken: (vault: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('vault_token'), vault.toBuffer(), mint.toBuffer()],
      PROGRAM_ID,
    )[0],
};

/** `Unit`, in declaration order. */
export const UNIT = { Share: 0, Ounce: 1 } as const;

/** `MultiplierSource`, in declaration order. */
export const MULTIPLIER = { Fixed: 0, Token2022ScaledUi: 1, KeeperPushed: 2 } as const;

/** `WrapperStatus`, in declaration order. */
export const WRAPPER_STATUS = { Active: 0, MintDisabled: 1, Quarantined: 2, Frozen: 3 } as const;
