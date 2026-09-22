/**
 * Deploy preflight. Reads only; sends nothing, signs nothing.
 *
 * `CLAUDE.md` requires that the exact sequence of actions is written out and
 * approved before the first one runs. This script produces that list from the
 * real state of the machine rather than from memory: which cluster the CLI
 * points at, whether the built program matches the declared id, whether the
 * deployer can actually pay, and what each step costs.
 *
 *   npm run deploy-preflight               # devnet, the default
 *   CLUSTER=mainnet npm run deploy-preflight
 *
 * The cluster is an explicit choice rather than whatever the CLI happens to
 * be set to, and the script stops if the two disagree. It exits non-zero if
 * anything would fail, so it can gate a deploy. It never prints a secret key,
 * only the public key derived from one.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { CLUSTER, PROGRAM_ID as DECLARED_ID, RPC_URL, connection, keypairAt } from './lib/env.js';

const PROGRAM_SO = 'target/deploy/quorum.so';
const PROGRAM_KEYPAIR = 'target/deploy/quorum-keypair.json';

/** Loader overhead on top of the raw byte count, for the upgrade buffer. */
const PROGRAM_ACCOUNT_OVERHEAD = 45;

/**
 * How much spare room to allocate for future upgrades, as a multiple of the
 * current binary. `solana program deploy` defaults to 2, which on a 650KB
 * program is about 6.6 SOL of rent. 1.5 leaves room for meaningful growth at
 * two thirds the cost, which matters on a devnet wallet that cannot simply be
 * topped up.
 */
const UPGRADE_HEADROOM = Number(process.env.UPGRADE_HEADROOM ?? 1.5);

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

function keypairFrom(path: string) {
  try {
    return keypairAt(path);
  } catch {
    return null;
  }
}

function cliConfig(): Record<string, string> {
  try {
    const out = execFileSync('solana', ['config', 'get'], { encoding: 'utf8' });
    return Object.fromEntries(
      out
        .split('\n')
        .map((l) => l.split(/:\s(.+)/))
        .filter((p) => p.length >= 2)
        .map(([k, v]) => [k.trim(), v.trim()]),
    );
  } catch {
    return {};
  }
}

async function main() {
  const conn = connection();
  const cfg = cliConfig();

  // 1. Cluster. `solana program deploy` uses the CLI's own setting, not this
  //    script's, so a disagreement means the deploy lands somewhere else.
  const cliRpc = cfg['RPC URL'] ?? 'unknown';
  const cliMatches = cliRpc.includes(CLUSTER === 'mainnet' ? 'mainnet' : 'devnet');
  add(
    `CLI cluster is ${CLUSTER}`,
    cliMatches,
    cliMatches ? cliRpc : `points at ${cliRpc}. Run: solana config set --url ${RPC_URL}`,
  );

  // 2. The built artifact.
  let soBytes = 0;
  try {
    soBytes = statSync(PROGRAM_SO).size;
    add('Program binary exists', true, `${PROGRAM_SO}, ${soBytes.toLocaleString()} bytes`);
  } catch {
    add('Program binary exists', false, `${PROGRAM_SO} missing. Run: anchor build`);
  }

  // 3. The program keypair has to match what the source declares, or every
  //    PDA the frontend and tests derive points at a program that is not there.
  const programKp = keypairFrom(PROGRAM_KEYPAIR);
  if (!programKp) {
    add('Program keypair readable', false, `${PROGRAM_KEYPAIR} missing or malformed`);
  } else {
    const matches = programKp.publicKey.toBase58() === DECLARED_ID;
    add(
      'Program id matches declare_id!',
      matches,
      matches
        ? DECLARED_ID
        : `keypair is ${programKp.publicKey.toBase58()}, source declares ${DECLARED_ID}`,
    );
  }

  // 4. Is it already deployed? A second deploy of a live program is an
  //    upgrade, which is a different conversation from a first deploy.
  const existing = await conn.getAccountInfo(new PublicKey(DECLARED_ID));
  add(
    'Program id is unused',
    existing === null,
    existing === null
      ? 'no account at this id yet, so this would be a first deploy'
      : `ALREADY DEPLOYED, ${existing.data.length} bytes. This would be an UPGRADE.`,
  );

  // 5. Money. Rent is refundable on close; the fee is not.
  const deployerKp = keypairFrom(cfg['Keypair Path'] ?? '');
  const maxLen = Math.ceil((soBytes + PROGRAM_ACCOUNT_OVERHEAD) * UPGRADE_HEADROOM);
  const rentLamports = await conn.getMinimumBalanceForRentExemption(maxLen);
  const rentSol = rentLamports / LAMPORTS_PER_SOL;

  if (!deployerKp) {
    add('Deployer keypair readable', false, `${cfg['Keypair Path'] ?? '(unset)'} unreadable`);
  } else {
    const balance = (await conn.getBalance(deployerKp.publicKey)) / LAMPORTS_PER_SOL;
    const needed = rentSol + 0.05;
    add(
      'Deployer can pay',
      balance >= needed,
      `${deployerKp.publicKey.toBase58()} holds ${balance.toFixed(4)} SOL, ` +
        `needs about ${needed.toFixed(2)} (${rentSol.toFixed(2)} rent, refundable, plus fees)`,
    );
  }

  // --- report ---
  console.log(`\nQuorum deploy preflight: ${CLUSTER}\nRPC ${RPC_URL}\n`);
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'STOP'}  ${c.name.padEnd(30)} ${c.detail}`);
  }

  console.log(`
What a deploy would do, in order:

  1. solana program deploy ${PROGRAM_SO} \\
       --program-id ${PROGRAM_KEYPAIR} \\
       --max-len ${maxLen}
     Writes ${soBytes.toLocaleString()} bytes on-chain and locks about
     ${rentSol.toFixed(2)} SOL as rent, refundable only by closing the program.

  2. initialize_vault, once per vault. Each opens PAUSED and creates its index
     mint under the vault PDA.

  3. register_wrapper, once per wrapper. Opens a PDA-owned token account and
     refuses any mint whose extensions contradict its declared multiplier
     source (invariant 5 in README.md).

  4. Seed each vault while PAUSED. Only the authority may deposit, and the
     issuer cap is skipped, because the first deposit is 100% of one issuer.

  5. unpause, once the basket is balanced and NAV reads correctly.

Nothing above has run. Step 1 cannot be undone without closing the program.
${
  CLUSTER === 'mainnet'
    ? 'Every step spends real money.'
    : 'On devnet the SOL is free, but the program id and the rent are not\nreclaimed unless the program is explicitly closed.'
}

On devnet, steps 2 through 5 are scripted:
  npx tsx scripts/devnet_mocks.ts --send
  npx tsx scripts/devnet_post_prices.ts --send
  npx tsx scripts/devnet_init.ts --send
`);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    console.error(`${failed.length} check(s) would block a deploy.\n`);
    process.exit(1);
  }
  console.log('All checks pass. A deploy still needs an explicit go-ahead.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
