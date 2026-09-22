/**
 * Wrapper audit (`Quorum_Spec_v5.pdf` §11), run before any wrapper is
 * registered.
 *
 * Reads mainnet and reports, per wrapper: mint, token program, decimals, every
 * Token-2022 extension, the transfer-restriction surface (freeze authority,
 * permanent delegate, transfer hook, default-frozen, non-transferable, pausable),
 * supply, deepest holders, Jupiter routability, and the Pyth feed situation.
 *
 * The question this script exists to answer is "can a program-owned PDA hold this
 * token at all". If the answer is no for any wrapper, the design changes and that
 * is a decision for the team, not something to work around.
 *
 *   npm run verify-wrappers              # read-only, safe, no keys touched
 *   npm run verify-wrappers -- --dust    # ALSO sends real dust on mainnet. Costs money.
 *
 * Writes docs/wrapper_audit.md.
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getExtensionTypes,
  ExtensionType,
  getPermanentDelegate,
  getTransferHook,
  getDefaultAccountState,
  getTransferFeeConfig,
  getScaledUiAmountConfig,
  AccountState,
} from '@solana/spl-token';
import { VAULTS, QUOTE_ASSETS, type WrapperEntry, type VaultEntry } from '../config/wrappers.js';

const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const DUST = process.argv.includes('--dust');

/** Public RPC rate-limits hard; keep requests spaced and retry on 429. */
const THROTTLE_MS = RPC_URL.includes('api.mainnet-beta.solana.com') ? 400 : 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await sleep(THROTTLE_MS);
      return await fn();
    } catch (err) {
      lastErr = err;
      const backoff = 800 * 2 ** i;
      process.stderr.write(`  retry ${i + 1}/${tries} ${label} in ${backoff}ms\n`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * A restriction that bears on whether a PDA can hold the token, and how badly it
 * hurts if it can. `blocking` means the vault design does not work with this token.
 */
interface Restriction {
  flag: string;
  detail: string;
  blocking: boolean;
}

interface WrapperReport {
  entry: WrapperEntry;
  vault: string;
  found: boolean;
  error?: string;
  tokenProgram?: 'SPL Token' | 'Token-2022' | string;
  decimals?: number;
  supply?: string;
  uiSupply?: string;
  extensions?: string[];
  restrictions: Restriction[];
  scaledUiMultiplier?: string;
  pdaVerdict: 'OK' | 'BLOCKED' | 'NEEDS_LIVE_TEST' | 'UNKNOWN';
  pdaReason: string;
  topHolders?: { address: string; amount: string; owner?: string }[];
  jupiter?: string;
}

function programName(owner: PublicKey): string {
  if (owner.equals(TOKEN_PROGRAM_ID)) return 'SPL Token';
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return 'Token-2022';
  return `UNKNOWN (${owner.toBase58()})`;
}

async function auditWrapper(
  conn: Connection,
  vault: VaultEntry,
  entry: WrapperEntry,
): Promise<WrapperReport> {
  const report: WrapperReport = {
    entry,
    vault: vault.symbol,
    found: false,
    restrictions: [],
    pdaVerdict: 'UNKNOWN',
    pdaReason: '',
  };

  if (!entry.mint) {
    report.error = 'No mint address in config/wrappers.ts: research has not produced a trustworthy address.';
    report.pdaReason = 'Cannot test without a mint address.';
    return report;
  }

  let mintPk: PublicKey;
  try {
    mintPk = new PublicKey(entry.mint);
  } catch {
    report.error = `Not a valid base58 public key: ${entry.mint}`;
    return report;
  }

  const info = await withRetry(`${entry.key} getAccountInfo`, () => conn.getAccountInfo(mintPk));
  if (!info) {
    report.error = 'Account does not exist on mainnet.';
    report.pdaVerdict = 'BLOCKED';
    report.pdaReason = 'Mint not found.';
    return report;
  }

  report.found = true;
  report.tokenProgram = programName(info.owner);

  const isToken2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !isToken2022) {
    report.error = `Mint is not owned by a known token program (owner ${info.owner.toBase58()}).`;
    report.pdaVerdict = 'BLOCKED';
    report.pdaReason = 'Unknown token program.';
    return report;
  }

  const mint = unpackMint(mintPk, info, info.owner);
  report.decimals = mint.decimals;
  report.supply = mint.supply.toString();
  report.uiSupply = (Number(mint.supply) / 10 ** mint.decimals).toLocaleString('en-US', {
    maximumFractionDigits: 4,
  });

  if (mint.freezeAuthority) {
    report.restrictions.push({
      flag: 'Freeze authority',
      detail: `${mint.freezeAuthority.toBase58()} can freeze the vault's token account, stranding that leg of the basket.`,
      blocking: false,
    });
  }

  if (isToken2022) {
    const types = getExtensionTypes(mint.tlvData);
    report.extensions = types.map((t) => ExtensionType[t] ?? `Unknown(${t})`);

    const permanentDelegate = getPermanentDelegate(mint);
    if (permanentDelegate?.delegate) {
      report.restrictions.push({
        flag: 'Permanent delegate',
        detail: `${permanentDelegate.delegate.toBase58()} can move tokens out of the vault at will. Spec §11 "issuer seizure": issuer caps limit the damage but do not remove it.`,
        blocking: false,
      });
    }

    const hook = getTransferHook(mint);
    if (hook?.programId && !hook.programId.equals(PublicKey.default)) {
      report.restrictions.push({
        flag: 'Transfer hook',
        detail: `Hook program ${hook.programId.toBase58()} runs on every transfer and may reject a PDA owner. This is the classic allowlist mechanism: must be tested live.`,
        blocking: false,
      });
    }

    const das = getDefaultAccountState(mint);
    if (das?.state === AccountState.Frozen) {
      report.restrictions.push({
        flag: 'Default account state = FROZEN',
        detail:
          'Every new token account starts frozen and must be thawed by the issuer. A PDA cannot receive this token without issuer cooperation. This is allowlist-gated.',
        blocking: true,
      });
    }

    const fee = getTransferFeeConfig(mint);
    if (fee) {
      const bps = fee.newerTransferFee.transferFeeBasisPoints;
      if (bps > 0) {
        report.restrictions.push({
          flag: 'Transfer fee',
          detail: `${bps} bps on every transfer. Breaks the "measured delta == amount received" assumption unless accounted for; invariant 2 still holds because the delta is measured, but NAV math must expect the haircut.`,
          blocking: false,
        });
      }
    }

    if (types.includes(ExtensionType.NonTransferable)) {
      report.restrictions.push({
        flag: 'Non-transferable',
        detail: 'Token cannot be transferred at all. Unusable in a vault.',
        blocking: true,
      });
    }

    if (types.includes(ExtensionType.PausableConfig)) {
      report.restrictions.push({
        flag: 'Pausable',
        detail: 'The issuer can halt all transfers, which would freeze redeems for this leg.',
        blocking: false,
      });
    }

    const scaled = getScaledUiAmountConfig(mint);
    if (scaled) {
      report.scaledUiMultiplier = String(scaled.multiplier);
      if (entry.multiplierSource !== 'TOKEN2022_SCALED_UI') {
        report.restrictions.push({
          flag: 'CONFIG MISMATCH',
          detail: `Mint has a Scaled UI Amount config (multiplier ${scaled.multiplier}) but config/wrappers.ts declares multiplierSource=${entry.multiplierSource}. Reading the raw balance here would silently undervalue NAV: invariant 5.`,
          blocking: false,
        });
      }
    } else if (entry.multiplierSource === 'TOKEN2022_SCALED_UI') {
      report.restrictions.push({
        flag: 'CONFIG MISMATCH',
        detail:
          'config/wrappers.ts declares multiplierSource=TOKEN2022_SCALED_UI but the mint has no Scaled UI Amount extension. One of the two is wrong.',
        blocking: false,
      });
    }
  } else {
    report.extensions = [];
    if (entry.multiplierSource === 'TOKEN2022_SCALED_UI') {
      report.restrictions.push({
        flag: 'CONFIG MISMATCH',
        detail: 'Declared as Token-2022 Scaled UI, but the mint is a plain SPL Token with no extensions.',
        blocking: false,
      });
    }
  }

  // PDA-holdability verdict from the extension surface alone. Anything short of
  // "plainly fine" needs the live dust test before it can be trusted.
  const blocking = report.restrictions.filter((r) => r.blocking);
  const needsLive = report.restrictions.some((r) => r.flag === 'Transfer hook');
  if (blocking.length > 0) {
    report.pdaVerdict = 'BLOCKED';
    report.pdaReason = blocking.map((r) => r.flag).join('; ');
  } else if (needsLive) {
    report.pdaVerdict = 'NEEDS_LIVE_TEST';
    report.pdaReason = 'Transfer hook present: only a real transfer to a PDA proves it is allowed.';
  } else {
    report.pdaVerdict = 'OK';
    report.pdaReason = 'No allowlist-style restriction found. A PDA-owned ATA should hold this.';
  }

  // Largest holders double as pool discovery: the deepest accounts are usually
  // the canonical AMM vaults to register for the depeg TWAP (spec §9.1).
  // Single attempt, no retry: the public RPC rate-limits this call hard and it
  // is informational only. Losing it must not cost us the whole audit.
  try {
    await sleep(THROTTLE_MS);
    const largest = await conn.getTokenLargestAccounts(mintPk);
    report.topHolders = largest.value.slice(0, 5).map((a) => ({
      address: a.address.toBase58(),
      amount: a.uiAmountString ?? a.amount,
    }));
  } catch (err) {
    report.topHolders = [];
  }

  // Routability: can Jupiter price 1 token against USDC at all? A wrapper with no
  // route cannot be used in swap-and-mint and has no DEX price for the depeg test.
  try {
    const amount = 10 ** mint.decimals;
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${entry.mint}&outputMint=${QUOTE_ASSETS.USDC}&amount=${amount}&slippageBps=100`;
    const res = await fetch(url);
    if (res.ok) {
      const q = (await res.json()) as { outAmount?: string; routePlan?: unknown[] };
      if (q.outAmount) {
        const usdc = Number(q.outAmount) / 1e6;
        report.jupiter = `1 token -> ${usdc.toFixed(4)} USDC via ${q.routePlan?.length ?? '?'} hop(s)`;
      } else {
        report.jupiter = 'no route';
      }
    } else {
      report.jupiter = `no route (HTTP ${res.status})`;
    }
  } catch (err) {
    report.jupiter = `quote failed: ${(err as Error).message}`;
  }

  return report;
}

function renderMarkdown(reports: WrapperReport[], pythNotes: string): string {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push('# Wrapper audit');
  lines.push('');
  lines.push(`Generated by \`scripts/verify_wrappers.ts\` against \`${RPC_URL}\` at ${ts}.`);
  lines.push('');
  lines.push(
    DUST
      ? '**PDA dust test: RUN.** Verdicts below marked `OK (live)` were proven by a real mainnet transfer.'
      : '**PDA dust test: NOT RUN.** Every PDA verdict below is inferred from the extension set only. Re-run with `--dust` to prove it.',
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Vault | Wrapper | Issuer | Mint | Program | Dec | PDA can hold? |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of reports) {
    const mint = r.entry.mint ? `\`${r.entry.mint.slice(0, 8)}…\`` : '**MISSING**';
    lines.push(
      `| ${r.vault} | ${r.entry.key} | ${r.entry.issuer} | ${mint} | ${r.tokenProgram ?? ', '} | ${r.decimals ?? ', '} | ${r.pdaVerdict} |`,
    );
  }
  lines.push('');

  const blocked = reports.filter((r) => r.pdaVerdict === 'BLOCKED');
  if (blocked.length) {
    lines.push('## STOP: blocking findings');
    lines.push('');
    lines.push(
      'The build prompt says: "If a wrapper turns out to be allowlist-restricted so a PDA cannot hold it, stop and report it. That changes the design and needs a decision, not a workaround."',
    );
    lines.push('');
    for (const r of blocked) {
      lines.push(`- **${r.entry.key}** (${r.vault}): ${r.pdaReason}`);
    }
    lines.push('');
  }

  lines.push('## Per-wrapper detail');
  lines.push('');
  for (const r of reports) {
    lines.push(`### ${r.entry.key}: ${r.entry.issuer} (${r.vault})`);
    lines.push('');
    if (!r.entry.mint) {
      lines.push(`- **Mint:** MISSING: ${r.error}`);
      lines.push('');
      continue;
    }
    lines.push(`- **Mint:** \`${r.entry.mint}\``);
    lines.push(`- **Address source:** ${r.entry.source ?? '_none recorded_'} (confidence: ${r.entry.confidence})`);
    if (r.error) {
      lines.push(`- **ERROR:** ${r.error}`);
      lines.push('');
      continue;
    }
    lines.push(`- **Token program:** ${r.tokenProgram}`);
    lines.push(`- **Decimals:** ${r.decimals}`);
    lines.push(`- **Supply:** ${r.uiSupply} (raw ${r.supply})`);
    lines.push(`- **Extensions:** ${r.extensions?.length ? r.extensions.join(', ') : 'none'}`);
    if (r.scaledUiMultiplier !== undefined) {
      lines.push(`- **Scaled UI multiplier:** ${r.scaledUiMultiplier} (NAV must read the scaled amount, invariant 5)`);
    }
    lines.push(`- **Declared multiplier source:** ${r.entry.multiplierSource}`);
    lines.push(`- **Dividend mechanism:** ${r.entry.dividendMechanism ?? '**UNDOCUMENTED**. Ask the issuer before registering it.'}`);
    lines.push(`- **PDA verdict:** ${r.pdaVerdict}: ${r.pdaReason}`);
    lines.push(`- **Jupiter:** ${r.jupiter ?? 'not measured'}`);
    if (r.restrictions.length) {
      lines.push('- **Restrictions:**');
      for (const x of r.restrictions) {
        lines.push(`  - ${x.blocking ? '**[BLOCKING]** ' : ''}${x.flag}: ${x.detail}`);
      }
    } else {
      lines.push('- **Restrictions:** none detected');
    }
    if (r.topHolders?.length) {
      lines.push('- **Largest accounts** (pool candidates for the depeg TWAP, spec §9.1):');
      for (const h of r.topHolders) lines.push(`  - \`${h.address}\`: ${h.amount}`);
    }
    if (r.entry.notes) lines.push(`- **Note:** ${r.entry.notes}`);
    lines.push('');
  }

  lines.push('## Pyth feeds');
  lines.push('');
  lines.push(pythNotes);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Dust test: ${DUST ? 'ENABLED (real mainnet writes)' : 'disabled (read-only)'}\n`);

  if (DUST) {
    console.error(
      'The --dust path sends real tokens on mainnet and is not implemented yet.\n' +
        'It needs a funded keypair, a per-wrapper dust cap and an explicit go-ahead (spec: "Mainnet means real money").\n',
    );
    process.exit(1);
  }

  const conn = new Connection(RPC_URL, 'confirmed');
  const reports: WrapperReport[] = [];

  for (const vault of VAULTS) {
    for (const entry of vault.wrappers) {
      process.stdout.write(`${vault.symbol}/${entry.key} … `);
      const r = await auditWrapper(conn, vault, entry);
      reports.push(r);
      if (!entry.mint) console.log('SKIP (no mint address)');
      else if (r.error) console.log(`ERROR: ${r.error}`);
      else console.log(`${r.tokenProgram}, ${r.decimals}d, PDA=${r.pdaVerdict}`);
    }
  }

  const missing = reports.filter((r) => !r.entry.mint);
  const pythNotes = VAULTS.map(
    (v) => `- **${v.underlying}/USD** (for ${v.symbol}): ${v.pythFeedId ? `\`${v.pythFeedId}\`` : '**feed id not yet recorded**'}`,
  ).join('\n');

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/wrapper_audit.md', renderMarkdown(reports, pythNotes));
  console.log('\nWrote docs/wrapper_audit.md');

  if (missing.length) {
    console.log(`\n${missing.length}/${reports.length} wrappers have no mint address yet: ${missing.map((m) => m.entry.key).join(', ')}`);
  }
  const blocked = reports.filter((r) => r.pdaVerdict === 'BLOCKED');
  if (blocked.length) {
    console.log(`\nSTOP: ${blocked.length} wrapper(s) cannot be held by a PDA: ${blocked.map((b) => b.entry.key).join(', ')}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
