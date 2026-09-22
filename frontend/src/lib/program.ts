/**
 * Client-side instruction building for the Quorum program.
 *
 * This mirrors `scripts/lib/ix.ts` at the repo root, which the integration
 * tests use. Two copies exist because the frontend deploys to Vercel from its
 * own directory and cannot import across it, the same constraint that makes
 * `vaults.ts` a copy. Copies drift, so `tests/frontend_parity.test.ts` builds
 * the same instructions through both paths and asserts the bytes are
 * identical. If you change an account order here, that test fails.
 *
 * Account order is positional: Anchor matches by index, not by name, so a
 * reordering is a silent wrong-account bug rather than a compile error.
 */
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { concatBytes, u64le } from './bytes';

export const PROGRAM_ID = new PublicKey('3Awpi9YyDb4432qSiBLGN9PkiSRvFYKjmpNYxy1BuRoi');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/**
 * Anchor's instruction discriminators, `sha256("global:<name>")[..8]`.
 *
 * Hardcoded rather than hashed at runtime: the browser's only SHA-256 is
 * `crypto.subtle`, which is async, and an async hash inside instruction
 * building would spread promises through code that has no other reason to be
 * asynchronous. The parity test recomputes these from the names.
 */
export const DISC = {
  mint_in_kind: Uint8Array.from([101, 248, 37, 42, 151, 216, 11, 83]),
  redeem_in_kind: Uint8Array.from([102, 58, 189, 252, 192, 219, 140, 89]),
  update_nav: Uint8Array.from([56, 16, 234, 109, 155, 165, 5, 0]),
  begin_rebalance: Uint8Array.from([231, 83, 87, 166, 123, 155, 58, 182]),
  begin_swap_depegged: Uint8Array.from([246, 188, 252, 188, 120, 202, 191, 112]),
  end_swap: Uint8Array.from([177, 184, 27, 193, 34, 13, 210, 145]),
};

const enc = new TextEncoder();

export const SEEDS = {
  vault: (symbol: string) =>
    PublicKey.findProgramAddressSync([enc.encode('vault'), enc.encode(symbol)], PROGRAM_ID)[0],
  indexMint: (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([enc.encode('index_mint'), vault.toBuffer()], PROGRAM_ID)[0],
  wrapper: (vault: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [enc.encode('wrapper'), vault.toBuffer(), mint.toBuffer()],
      PROGRAM_ID,
    )[0],
  vaultToken: (vault: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [enc.encode('vault_token'), vault.toBuffer(), mint.toBuffer()],
      PROGRAM_ID,
    )[0],
  swapTicket: (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([enc.encode('swap_ticket'), vault.toBuffer()], PROGRAM_ID)[0],
};

/** The associated token account, derived rather than pulled from spl-token. */
export function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

/**
 * `CreateIdempotent` on the associated token program: instruction 1, no other
 * data. Safe to include even when the account exists, which is what lets a
 * mint be a single transaction regardless of whether the user has traded
 * before.
 */
export function createAtaIdempotent(args: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  const account = ata(args.mint, args.owner, args.tokenProgram);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(Uint8Array.from([1])),
  });
}

/**
 * Instruction data as a Buffer, built from plain byte arrays.
 *
 * `Buffer` in the browser is a polyfill without Node's BigInt accessors, so
 * `Buffer.alloc(8).writeBigUInt64LE(n)` throws there while passing every
 * test under node. The bytes are assembled with DataView and only wrapped in
 * a Buffer at the end, which `TransactionInstruction` wants.
 */
const data = (...parts: Uint8Array[]) => Buffer.from(concatBytes(parts));

const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

export interface Leg {
  mint: PublicKey;
  tokenProgram: PublicKey;
}

/**
 * One `(config, vault token account, mint)` triple per registered wrapper, in
 * registry order. `nav::walk_registry` re-derives each config PDA, so the
 * order is checked on-chain rather than trusted.
 */
function navTriples(vault: PublicKey, legs: Leg[]) {
  return legs.flatMap((l) => [
    ro(SEEDS.wrapper(vault, l.mint)),
    ro(SEEDS.vaultToken(vault, l.mint)),
    ro(l.mint),
  ]);
}

/** `MintInKind`. Deposit one whitelisted wrapper, receive index tokens. */
export function mintInKind(args: {
  user: PublicKey;
  symbol: string;
  mint: PublicKey;
  wrapperTokenProgram: PublicKey;
  priceUpdate: PublicKey;
  legs: Leg[];
  amount: bigint;
  minIndexOut: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  const indexMint = SEEDS.indexMint(vault);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: false },
      rw(vault),
      ro(SEEDS.wrapper(vault, args.mint)),
      ro(args.mint),
      rw(SEEDS.vaultToken(vault, args.mint)),
      rw(ata(args.mint, args.user, args.wrapperTokenProgram)),
      rw(indexMint),
      rw(ata(indexMint, args.user, TOKEN_2022_PROGRAM)),
      ro(args.priceUpdate),
      ro(args.wrapperTokenProgram),
      ro(TOKEN_2022_PROGRAM),
      ...navTriples(vault, args.legs),
    ],
    data: data(DISC.mint_in_kind, u64le(args.amount), u64le(args.minIndexOut)),
  });
}

/**
 * `RedeemInKind`. Burn index tokens for a pro-rata slice of every leg.
 *
 * Takes a quad per wrapper rather than a triple: the user's destination
 * account is the fourth. Reads no oracle at all, which is why it stays open
 * when a stale price has shut everything else (invariant 7).
 */
export function redeemInKind(args: {
  user: PublicKey;
  symbol: string;
  legs: Leg[];
  indexAmount: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  const indexMint = SEEDS.indexMint(vault);
  const quads = args.legs.flatMap((l) => [
    ro(SEEDS.wrapper(vault, l.mint)),
    rw(SEEDS.vaultToken(vault, l.mint)),
    ro(l.mint),
    rw(ata(l.mint, args.user, l.tokenProgram)),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: false },
      ro(vault),
      rw(indexMint),
      rw(ata(indexMint, args.user, TOKEN_2022_PROGRAM)),
      ro(TOKEN_PROGRAM),
      ro(TOKEN_2022_PROGRAM),
      ...quads,
    ],
    data: data(DISC.redeem_in_kind, u64le(args.indexAmount)),
  });
}

/**
 * NAV triples with the vault's token accounts writable.
 *
 * The swap paths move balances in those accounts, so they have to be
 * writable here; the read-only paths leave them read-only.
 */
function navTriplesWritable(vault: PublicKey, legs: Leg[]) {
  return legs.flatMap((l) => [
    ro(SEEDS.wrapper(vault, l.mint)),
    rw(SEEDS.vaultToken(vault, l.mint)),
    ro(l.mint),
  ]);
}

/**
 * `begin_rebalance`. Borrows from a leg that is over its target weight.
 *
 * The vault does not route anything: it hands the tokens to the caller and
 * proves that `end_swap` appears later in the same transaction. Whatever
 * happens in between is the caller's business.
 */
export function beginRebalance(args: {
  caller: PublicKey;
  symbol: string;
  sourceMint: PublicKey;
  destMint: PublicKey;
  sourceTokenProgram: PublicKey;
  priceUpdate: PublicKey;
  legs: Leg[];
  amount: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.caller, isSigner: true, isWritable: true },
      rw(vault),
      rw(SEEDS.swapTicket(vault)),
      ro(SEEDS.wrapper(vault, args.sourceMint)),
      ro(SEEDS.wrapper(vault, args.destMint)),
      rw(SEEDS.vaultToken(vault, args.sourceMint)),
      rw(ata(args.sourceMint, args.caller, args.sourceTokenProgram)),
      ro(args.sourceMint),
      ro(SEEDS.indexMint(vault)),
      ro(args.priceUpdate),
      ro(args.sourceTokenProgram),
      ro(SystemProgram.programId),
      ro(SYSVAR_INSTRUCTIONS_PUBKEY),
      ...navTriplesWritable(vault, args.legs),
    ],
    data: data(DISC.begin_rebalance, u64le(args.amount)),
  });
}

/**
 * `end_swap`. Repays the loan and enforces the bounds.
 *
 * Every check happens here: the destination leg must clear its floor, the
 * basket total must hold, and the destination must stay inside its cap. A
 * failure reverts the loan with it.
 */
export function endSwap(args: {
  caller: PublicKey;
  symbol: string;
  sourceMint: PublicKey;
  destMint: PublicKey;
  destTokenProgram: PublicKey;
  priceUpdate: PublicKey;
  legs: Leg[];
  amount: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  const indexMint = SEEDS.indexMint(vault);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.caller, isSigner: true, isWritable: true },
      rw(vault),
      rw(SEEDS.swapTicket(vault)),
      rw(SEEDS.wrapper(vault, args.sourceMint)),
      ro(SEEDS.wrapper(vault, args.destMint)),
      ro(SEEDS.vaultToken(vault, args.sourceMint)),
      rw(SEEDS.vaultToken(vault, args.destMint)),
      rw(ata(args.destMint, args.caller, args.destTokenProgram)),
      ro(args.destMint),
      rw(indexMint),
      rw(ata(indexMint, args.caller, TOKEN_2022_PROGRAM)),
      ro(args.priceUpdate),
      ro(args.destTokenProgram),
      ro(TOKEN_2022_PROGRAM),
      ro(SYSVAR_INSTRUCTIONS_PUBKEY),
      ...navTriplesWritable(vault, args.legs),
    ],
    data: data(DISC.end_swap, u64le(args.amount)),
  });
}
