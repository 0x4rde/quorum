/**
 * Instruction builders for the Quorum program.
 *
 * Account order here mirrors the `#[derive(Accounts)]` structs one for one;
 * Anchor matches positionally, so a reordering is a silent wrong-account bug
 * rather than a compile error. Each builder names the struct it follows.
 *
 * Every NAV-reading instruction takes one triple per registered wrapper in
 * `remaining_accounts`, in registry order: wrapper config, the vault's token
 * account, the mint. `nav::walk_registry` re-derives each config PDA, so the
 * order is checked rather than trusted.
 */
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  PROGRAM_ID,
  SEEDS,
  ixDisc,
  i64b,
  strb,
  u128b,
  u16b,
  u64b,
  u8b,
} from './codec.js';

/** Re-exported so `tests/frontend_parity.test.ts` can compare derivations. */
export { SEEDS as SEEDS_FOR_TEST } from './codec.js';

type Key = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
const ro = (pubkey: PublicKey): Key => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): Key => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey: PublicKey, isWritable = true): Key => ({ pubkey, isSigner: true, isWritable });

const ix = (keys: Key[], data: Buffer) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys, data });

/** One `(config, vault token account, mint)` triple per registered wrapper. */
export interface Leg {
  mint: PublicKey;
}

export function navTriples(vault: PublicKey, legs: Leg[], writable = false): Key[] {
  return legs.flatMap((l) => [
    ro(SEEDS.wrapper(vault, l.mint)),
    writable ? rw(SEEDS.vaultToken(vault, l.mint)) : ro(SEEDS.vaultToken(vault, l.mint)),
    ro(l.mint),
  ]);
}

// --- setup -----------------------------------------------------------------

export interface InitVaultArgs {
  symbol: string;
  unit: number;
  underlyingFeedId: Buffer;
  guardian: PublicKey;
  maxAgeSeconds: number;
  maxConfBps: number;
  feeMintBps: number;
  feeRedeemBps: number;
  marketClosedSurchargeBps: number;
  navBreakerBps: number;
  navBreakerWindowSeconds: number;
}

/** `InitializeVault`. */
export function initializeVault(authority: PublicKey, a: InitVaultArgs): TransactionInstruction {
  const vault = SEEDS.vault(a.symbol);
  return ix(
    [
      signer(authority),
      rw(vault),
      rw(SEEDS.indexMint(vault)),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(SystemProgram.programId),
      ro(SYSVAR_RENT_PUBKEY),
    ],
    Buffer.concat([
      ixDisc('initialize_vault'),
      strb(a.symbol),
      u8b(a.unit),
      a.underlyingFeedId,
      a.guardian.toBuffer(),
      u64b(a.maxAgeSeconds),
      u16b(a.maxConfBps),
      u16b(a.feeMintBps),
      u16b(a.feeRedeemBps),
      u16b(a.marketClosedSurchargeBps),
      u16b(a.navBreakerBps),
      i64b(a.navBreakerWindowSeconds),
    ]),
  );
}

export interface RegisterWrapperArgs {
  unitsPerToken: bigint;
  multiplierSource: number;
  targetWeightBps: number;
  maxWeightBps: number;
  haircutBps: number;
}

/** `RegisterWrapper`. */
export function registerWrapper(
  authority: PublicKey,
  symbol: string,
  mint: PublicKey,
  tokenProgram: PublicKey,
  a: RegisterWrapperArgs,
): TransactionInstruction {
  const vault = SEEDS.vault(symbol);
  return ix(
    [
      signer(authority),
      rw(vault),
      ro(mint),
      rw(SEEDS.wrapper(vault, mint)),
      rw(SEEDS.vaultToken(vault, mint)),
      ro(tokenProgram),
      ro(SystemProgram.programId),
    ],
    Buffer.concat([
      ixDisc('register_wrapper'),
      u128b(a.unitsPerToken),
      u8b(a.multiplierSource),
      u16b(a.targetWeightBps),
      u16b(a.maxWeightBps),
      u16b(a.haircutBps),
      PublicKey.default.toBuffer(), // dex_price_source: unset, no pool TWAP yet
      Buffer.alloc(32), // wrapper_feed_id
      u8b(0), // has_wrapper_feed
      Buffer.alloc(32), // rr_feed_id
      u8b(0), // has_rr_feed
    ]),
  );
}

/** `AuthorityAction`. */
export function unpause(authority: PublicKey, symbol: string): TransactionInstruction {
  return ix([signer(authority, false), rw(SEEDS.vault(symbol))], ixDisc('unpause'));
}

/** `GuardianAction`. */
export function pause(guardian: PublicKey, symbol: string): TransactionInstruction {
  return ix([signer(guardian, false), rw(SEEDS.vault(symbol))], ixDisc('pause'));
}

// --- user paths ------------------------------------------------------------

/** `MintInKind`, plus one NAV triple per registered wrapper. */
export function mintInKind(args: {
  user: PublicKey;
  symbol: string;
  mint: PublicKey;
  userWrapperAccount: PublicKey;
  userIndexAccount: PublicKey;
  priceUpdate: PublicKey;
  wrapperTokenProgram: PublicKey;
  legs: Leg[];
  amount: bigint;
  minIndexOut: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  return ix(
    [
      signer(args.user, false),
      rw(vault),
      ro(SEEDS.wrapper(vault, args.mint)),
      ro(args.mint),
      rw(SEEDS.vaultToken(vault, args.mint)),
      rw(args.userWrapperAccount),
      rw(SEEDS.indexMint(vault)),
      rw(args.userIndexAccount),
      ro(args.priceUpdate),
      ro(args.wrapperTokenProgram),
      ro(TOKEN_2022_PROGRAM_ID),
      ...navTriples(vault, args.legs),
    ],
    Buffer.concat([ixDisc('mint_in_kind'), u64b(args.amount), u64b(args.minIndexOut)]),
  );
}

/**
 * `RedeemInKind`, plus one quad per registered wrapper: config, the vault's
 * token account, the mint, and the user's destination account. Reads no
 * oracle, which is why it stays open when everything else is shut
 * (invariant 7 in `README.md`).
 */
export function redeemInKind(args: {
  user: PublicKey;
  symbol: string;
  userIndexAccount: PublicKey;
  legs: { mint: PublicKey; userAccount: PublicKey }[];
  tokenProgram: PublicKey;
  indexAmount: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  const quads = args.legs.flatMap((l) => [
    ro(SEEDS.wrapper(vault, l.mint)),
    rw(SEEDS.vaultToken(vault, l.mint)),
    ro(l.mint),
    rw(l.userAccount),
  ]);
  return ix(
    [
      signer(args.user, false),
      ro(vault),
      rw(SEEDS.indexMint(vault)),
      rw(args.userIndexAccount),
      ro(args.tokenProgram),
      ro(TOKEN_2022_PROGRAM_ID),
      ...quads,
    ],
    Buffer.concat([ixDisc('redeem_in_kind'), u64b(args.indexAmount)]),
  );
}

/** `UpdateNav`, plus one NAV triple per registered wrapper. */
export function updateNav(args: {
  symbol: string;
  priceUpdate: PublicKey;
  legs: Leg[];
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  return ix(
    [
      rw(vault),
      ro(SEEDS.indexMint(vault)),
      ro(args.priceUpdate),
      ...navTriples(vault, args.legs),
    ],
    ixDisc('update_nav'),
  );
}

// --- permissionless loan and settle ----------------------------------------

/**
 * `BeginSwap`, for either `begin_rebalance` or `begin_swap_depegged`.
 *
 * The loan lands in the caller's own account. Nothing here routes a trade:
 * the caller fills wherever it likes between this instruction and `end_swap`,
 * which must appear later in the same transaction (invariant 4).
 */
export function beginSwap(args: {
  which: 'begin_rebalance' | 'begin_swap_depegged';
  caller: PublicKey;
  symbol: string;
  sourceMint: PublicKey;
  destMint: PublicKey;
  callerSourceAccount: PublicKey;
  priceUpdate: PublicKey;
  sourceTokenProgram: PublicKey;
  legs: Leg[];
  amount: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  return ix(
    [
      signer(args.caller),
      rw(vault),
      rw(SEEDS.swapTicket(vault)),
      ro(SEEDS.wrapper(vault, args.sourceMint)),
      ro(SEEDS.wrapper(vault, args.destMint)),
      rw(SEEDS.vaultToken(vault, args.sourceMint)),
      rw(args.callerSourceAccount),
      ro(args.sourceMint),
      ro(SEEDS.indexMint(vault)),
      ro(args.priceUpdate),
      ro(args.sourceTokenProgram),
      ro(SystemProgram.programId),
      ro(SYSVAR_INSTRUCTIONS_PUBKEY),
      ...navTriples(vault, args.legs, true),
    ],
    Buffer.concat([ixDisc(args.which), u64b(args.amount)]),
  );
}

/** `SettleSwap`. Repays the loan and enforces the bounds. */
export function endSwap(args: {
  caller: PublicKey;
  symbol: string;
  sourceMint: PublicKey;
  destMint: PublicKey;
  callerDestAccount: PublicKey;
  callerIndexAccount: PublicKey;
  priceUpdate: PublicKey;
  destTokenProgram: PublicKey;
  legs: Leg[];
  amount: bigint;
}): TransactionInstruction {
  const vault = SEEDS.vault(args.symbol);
  return ix(
    [
      signer(args.caller),
      rw(vault),
      rw(SEEDS.swapTicket(vault)),
      rw(SEEDS.wrapper(vault, args.sourceMint)),
      ro(SEEDS.wrapper(vault, args.destMint)),
      ro(SEEDS.vaultToken(vault, args.sourceMint)),
      rw(SEEDS.vaultToken(vault, args.destMint)),
      rw(args.callerDestAccount),
      ro(args.destMint),
      rw(SEEDS.indexMint(vault)),
      rw(args.callerIndexAccount),
      ro(args.priceUpdate),
      ro(args.destTokenProgram),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(SYSVAR_INSTRUCTIONS_PUBKEY),
      ...navTriples(vault, args.legs, true),
    ],
    Buffer.concat([ixDisc('end_swap'), u64b(args.amount)]),
  );
}
