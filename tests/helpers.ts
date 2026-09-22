/**
 * Test scaffolding: fabricate the on-chain world the program expects.
 *
 * litesvm lets us write account data directly, which is the only practical way
 * to test against a Token-2022 mint carrying a live Scaled UI multiplier and a
 * Pyth PriceUpdateV2 at a chosen price. Neither can be minted into existence
 * with the normal SDKs.
 */
import { LiteSVM } from 'litesvm';
import { PublicKey, Keypair, TransactionInstruction, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  ACCOUNT_SIZE,
  AccountLayout,
  MintLayout,
} from '@solana/spl-token';

export {
  PROGRAM_ID,
  PYTH_RECEIVER,
  ixDisc,
  acctDisc,
  u8b,
  u16b,
  u32b,
  i32b,
  u64b,
  i64b,
  u128b,
  strb,
  SEEDS,
} from '../scripts/lib/codec.js';
import { acctDisc, i32b, i64b, u64b, u8b, PROGRAM_ID } from '../scripts/lib/codec.js';

/**
 * A Pyth `PriceUpdateV2` account, fabricated at whatever price the test needs.
 *
 * Layout mirrors pyth-solana-receiver-sdk:
 *   disc(8) write_authority(32) verification_level(1, Full=1)
 *   feed_id(32) price(i64) conf(u64) exponent(i32)
 *   publish_time(i64) prev_publish_time(i64) ema_price(i64) ema_conf(u64)
 *   posted_slot(u64)
 *
 * `verification_level` must be Full or `get_price_no_older_than` rejects it.
 */
export function pythAccount(opts: {
  feedId: Buffer;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  /**
   * The exponentially weighted average price, which rides in the same
   * message as spot. The depeg test reads this rather than the spot tick,
   * so a test that wants a depeg sets the two apart. Defaults to spot.
   */
  emaPrice?: bigint;
  emaConf?: bigint;
}): Buffer {
  return Buffer.concat([
    acctDisc('PriceUpdateV2'),
    PublicKey.default.toBuffer(),
    u8b(1), // VerificationLevel::Full
    opts.feedId,
    i64b(opts.price),
    u64b(opts.conf),
    i32b(opts.exponent),
    i64b(opts.publishTime),
    i64b(opts.publishTime),
    i64b(opts.emaPrice ?? opts.price),
    u64b(opts.emaConf ?? opts.conf),
    u64b(0n),
  ]);
}

/** A plain SPL Token mint. */
export function splMint(decimals: number, supply = 0n, mintAuthority?: PublicKey): Buffer {
  const b = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: mintAuthority ? 1 : 0,
      mintAuthority: mintAuthority ?? PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    b,
  );
  return b;
}

/**
 * A Token-2022 mint carrying a Scaled UI Amount config.
 *
 * This is the fixture invariant 5 (`README.md`) needs: without it, no test
 * can tell whether
 * the program reads the multiplier or silently reads the raw balance.
 */
export function scaledUiMint(decimals: number, multiplier: number, supply = 0n): Buffer {
  const len = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  const b = Buffer.alloc(len);
  // Base mint occupies the first 82 bytes.
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    b,
  );
  // Byte 165 is the account type discriminator: 1 = Mint.
  b.writeUInt8(1, 165);
  // TLV: type(2) length(2) then the extension body.
  let o = 166;
  b.writeUInt16LE(ExtensionType.ScaledUiAmountConfig, o); o += 2;
  const bodyLen = 32 + 8 + 8 + 8; // authority, multiplier, effective ts, new multiplier
  b.writeUInt16LE(bodyLen, o); o += 2;
  PublicKey.default.toBuffer().copy(b, o); o += 32;
  b.writeDoubleLE(multiplier, o); o += 8;
  b.writeBigInt64LE(0n, o); o += 8;          // effective immediately
  b.writeDoubleLE(multiplier, o);
  return b;
}

/** An SPL / Token-2022 token account holding `amount`. */
export function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    b,
  );
  return b;
}

export function setAccount(
  svm: LiteSVM,
  key: PublicKey,
  data: Buffer,
  owner: PublicKey,
  lamports?: number,
) {
  svm.setAccount(key, {
    lamports: lamports ?? Number(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data: new Uint8Array(data),
    owner,
    executable: false,
    rentEpoch: 0,
  });
}

export function send(
  svm: LiteSVM,
  payer: Keypair,
  ixs: TransactionInstruction[],
  signers: Keypair[] = [],
) {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  ixs.forEach((i) => tx.add(i));
  tx.sign(payer, ...signers);
  return svm.sendTransaction(tx);
}

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
