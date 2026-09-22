import { NextResponse } from 'next/server';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { DEVNET } from '@/lib/devnet';

/**
 * Devnet test tokens, so a visitor can try a mint without asking anyone.
 *
 * Sends a little SOL for fees and one drip of each mock wrapper in the
 * requested vault. Devnet only, and the tokens are worthless by
 * construction.
 *
 * ## The key this uses
 *
 * `FAUCET_SECRET_KEY` is a dedicated keypair created by
 * `scripts/devnet_faucet.ts`, holding nothing but a small SOL balance and
 * the mint authority of the seven mock mints. It is deliberately not the
 * deployer: it cannot pause a vault, change a parameter, move a vault
 * balance or upgrade the program. Someone who obtained it could mint
 * valueless devnet tokens and drain a fraction of a SOL.
 *
 * Unset, the route returns 503 and the button explains itself. Everything
 * else on the page keeps working.
 *
 * ## Rate limiting
 *
 * Serverless functions have no shared memory, so there is no counter to
 * keep. The balance itself is the limit: a request is refused if the
 * recipient already holds a drip of every leg. That is stateless, cannot be
 * bypassed by clearing anything client-side, and costs one RPC call.
 */
export const revalidate = 0;

const RPC = process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';

/** Whole tokens of each wrapper per request. Enough to mint and redeem. */
const DRIP_TOKENS = 5;

/**
 * Test dollars per request.
 *
 * mUSDC is what a visitor is actually handed now: it buys any holding at the
 * pools, so one token opens every vault instead of needing a different one
 * per basket. Enough to buy a meaningful slice of the shallow pools without
 * moving them far.
 */
const DRIP_USDC = 2_000;

/** Fee money. A mint costs well under a thousandth of this. */
const DRIP_SOL = 0.05;

/** Below this, the visitor cannot pay for a transaction, so top them up. */
const SOL_FLOOR = 0.02;

function faucetKeypair(): Keypair | null {
  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return null;
  }
}

const tokenProgramFor = (source: string) =>
  source === 'TOKEN2022_SCALED_UI' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

async function balanceOf(conn: Connection, account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  return info ? info.data.readBigUInt64LE(64) : 0n;
}

export async function POST(req: Request) {
  const faucet = faucetKeypair();
  if (!faucet) {
    return NextResponse.json(
      {
        error:
          'The faucet is not configured on this deployment. Set FAUCET_SECRET_KEY, ' +
          'or run scripts/devnet_faucet.ts locally to send yourself tokens.',
      },
      { status: 503 },
    );
  }

  let recipient: PublicKey;
  let symbol: string;
  try {
    const body = (await req.json()) as { address?: string; symbol?: string };
    recipient = new PublicKey(body.address ?? '');
    symbol = body.symbol ?? '';
  } catch {
    return NextResponse.json({ error: 'Bad request: need an address and a vault.' }, { status: 400 });
  }

  const vault = DEVNET.vaults.find((v) => v.symbol === symbol);
  if (!vault) {
    return NextResponse.json({ error: `No vault called ${symbol}.` }, { status: 400 });
  }

  const conn = new Connection(RPC, 'confirmed');

  try {
    const legs = vault.wrappers.map((w) => {
      const tokenProgram = tokenProgramFor(w.multiplierSource);
      const mint = new PublicKey(w.mint);
      return {
        ...w,
        mint,
        tokenProgram,
        account: getAssociatedTokenAddressSync(
          mint,
          recipient,
          true, // allow a PDA owner, in case someone points a program at this
          tokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      };
    });

    // The dollar first: it is the one token that works everywhere.
    const usdcMint = DEVNET.usdcMint ? new PublicKey(DEVNET.usdcMint) : null;
    const usdcAccount = usdcMint
      ? getAssociatedTokenAddressSync(usdcMint, recipient, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
      : null;
    const usdcHeld = usdcAccount ? await balanceOf(conn, usdcAccount) : 0n;
    const usdcDrip = BigInt(DRIP_USDC) * 10n ** 6n;
    const needsUsdc = Boolean(usdcMint) && usdcHeld < usdcDrip;

    const held = await Promise.all(legs.map((l) => balanceOf(conn, l.account)));
    const drip = legs.map((l) => BigInt(DRIP_TOKENS) * 10n ** BigInt(l.decimals));
    const alreadyStocked = held.every((h, i) => h >= drip[i]);

    const solBalance = (await conn.getBalance(recipient)) / LAMPORTS_PER_SOL;
    const needsSol = solBalance < SOL_FLOOR;

    if (alreadyStocked && !needsSol && !needsUsdc) {
      return NextResponse.json({
        error:
          'That wallet already has test USDC, every holding and enough SOL for ' +
          'fees. Spend some before asking for more.',
      }, { status: 429 });
    }

    const tx = new Transaction();
    if (needsUsdc && usdcMint && usdcAccount) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          faucet.publicKey, usdcAccount, recipient, usdcMint,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createMintToInstruction(
          usdcMint, usdcAccount, faucet.publicKey, usdcDrip - usdcHeld, [], TOKEN_PROGRAM_ID,
        ),
      );
    }
    if (needsSol) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: faucet.publicKey,
          toPubkey: recipient,
          lamports: Math.round(DRIP_SOL * LAMPORTS_PER_SOL),
        }),
      );
    }
    legs.forEach((l, i) => {
      if (held[i] >= drip[i]) return;
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          faucet.publicKey,
          l.account,
          recipient,
          l.mint,
          l.tokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createMintToInstruction(
          l.mint,
          l.account,
          faucet.publicKey,
          drip[i],
          [],
          l.tokenProgram,
        ),
      );
    });

    const signature = await sendAndConfirmTransaction(conn, tx, [faucet], {
      commitment: 'confirmed',
    });

    return NextResponse.json({
      signature,
      sol: needsSol ? DRIP_SOL : 0,
      usdc: needsUsdc ? DRIP_USDC : 0,
      tokens: legs.filter((_, i) => held[i] < drip[i]).map((l) => l.key),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
