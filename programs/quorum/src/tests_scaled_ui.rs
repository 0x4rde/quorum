//! Invariant 5 (`README.md`) regression tests, against real packed Token-2022
//! mint bytes.
//!
//! Invariant 5 needs a test that fails if anyone regresses it. The tests in
//! `units.rs` exercise the Fixed path with empty mint data, which proves
//! nothing, so these build real mints carrying a `ScaledUiAmountConfig`.
//!
//! The multipliers are the ones read off mainnet on 2026-09-20, so a failure
//! is legible against `docs/wrapper_audit.md`.

#![cfg(test)]

use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        scaled_ui_amount::{PodF64, ScaledUiAmountConfig},
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    },
    state::Mint as SplMint,
};

use crate::constants::UNITS_SCALE;
use crate::errors::QuorumError;
use crate::state::{MultiplierSource, WrapperConfig};
use crate::units::wrapper_units;

/// Pack a Token-2022 mint carrying a Scaled UI Amount config.
///
/// `effective_ts` and `new_multiplier` model a scheduled multiplier change,
/// which is how xStocks actually applies a dividend: the new value is written
/// ahead of time and takes effect at a timestamp.
fn scaled_ui_mint(
    decimals: u8,
    multiplier: f64,
    new_multiplier: f64,
    effective_ts: i64,
) -> Vec<u8> {
    let len = ExtensionType::try_calculate_account_len::<SplMint>(&[ExtensionType::ScaledUiAmount])
        .unwrap();
    let mut data = vec![0u8; len];
    {
        let mut state = StateWithExtensionsMut::<SplMint>::unpack_uninitialized(&mut data).unwrap();
        let ext = state.init_extension::<ScaledUiAmountConfig>(true).unwrap();
        ext.multiplier = PodF64::from(multiplier);
        ext.new_multiplier = PodF64::from(new_multiplier);
        ext.new_multiplier_effective_timestamp = effective_ts.into();

        state.base = SplMint {
            mint_authority: None.into(),
            supply: 1_000_000,
            decimals,
            is_initialized: true,
            freeze_authority: None.into(),
        };
        state.pack_base();
        state.init_account_type().unwrap();
    }
    data
}

/// A plain Token-2022 mint with no extensions at all.
fn plain_mint(decimals: u8) -> Vec<u8> {
    let len = ExtensionType::try_calculate_account_len::<SplMint>(&[]).unwrap();
    let mut data = vec![0u8; len];
    {
        let mut state = StateWithExtensionsMut::<SplMint>::unpack_uninitialized(&mut data).unwrap();
        state.base = SplMint {
            mint_authority: None.into(),
            supply: 1_000_000,
            decimals,
            is_initialized: true,
            freeze_authority: None.into(),
        };
        state.pack_base();
        state.init_account_type().unwrap();
    }
    data
}

fn wrapper(source: MultiplierSource, decimals: u8) -> WrapperConfig {
    WrapperConfig {
        decimals,
        is_token_2022: true,
        multiplier_source: source,
        target_weight_bps: 5_000,
        max_weight_bps: 6_000,
        ..Default::default()
    }
}

/// The trap: a vault holding 100 NVDAx must value them at the scaled amount.
///
/// NVDAx sat at multiplier 1.0009180758 on mainnet on 2026-09-20. Reading raw
/// would report exactly 100 units; reading correctly reports 100.09. If this
/// test ever asserts 100 * UNITS_SCALE, invariant 5 has regressed.
#[test]
fn scaled_ui_multiplier_is_applied_to_nav() {
    let w = wrapper(MultiplierSource::Token2022ScaledUi, 8);
    let data = scaled_ui_mint(8, 1.0009180758, 1.0009180758, 0);

    let units = wrapper_units(&w, 100 * 100_000_000, &data, 1_000).unwrap();

    let naive_raw = 100 * UNITS_SCALE;
    assert!(
        units > naive_raw,
        "reading the raw balance would undervalue NAV: got {units}, raw would be {naive_raw}"
    );
    // 100 * 1.0009180758 = 100.09180758
    assert_eq!(units, 100_091_807_580);
}

/// A dividend raises the multiplier, so the same token balance must be worth
/// more afterwards.
#[test]
fn nav_rises_across_an_xstocks_multiplier_increase() {
    let w = wrapper(MultiplierSource::Token2022ScaledUi, 8);
    let balance = 100 * 100_000_000;

    let before = wrapper_units(&w, balance, &scaled_ui_mint(8, 1.0, 1.0, 0), 1_000).unwrap();
    let after = wrapper_units(
        &w,
        balance,
        &scaled_ui_mint(8, 1.0009180758, 1.0009180758, 0),
        1_000,
    )
    .unwrap();

    assert_eq!(before, 100 * UNITS_SCALE);
    assert!(after > before);
    // The vault must gain exactly the dividend, no more and no less.
    assert_eq!(after - before, 91_807_580);
}

/// A scheduled multiplier must not be read before its effective timestamp, and
/// must be read from the moment it arrives. Getting this boundary wrong is the
/// same accounting bug, one tick early or late.
#[test]
fn scheduled_multiplier_respects_its_effective_timestamp() {
    let w = wrapper(MultiplierSource::Token2022ScaledUi, 8);
    let balance = 100 * 100_000_000;
    let data = scaled_ui_mint(8, 1.0, 1.0017012, 1_789_000_200);

    let before = wrapper_units(&w, balance, &data, 1_789_000_199).unwrap();
    let at = wrapper_units(&w, balance, &data, 1_789_000_200).unwrap();
    let after = wrapper_units(&w, balance, &data, 1_789_000_201).unwrap();

    assert_eq!(
        before,
        100 * UNITS_SCALE,
        "old multiplier applies before the switch"
    );
    assert_eq!(at, 100_170_120_000, "new multiplier applies at the switch");
    assert_eq!(after, at);
}

/// A mint configured as Scaled UI whose extension is gone must stop the read
/// rather than fall back to the raw balance.
#[test]
fn missing_extension_errors_instead_of_reading_raw() {
    let w = wrapper(MultiplierSource::Token2022ScaledUi, 8);
    let err = wrapper_units(&w, 100 * 100_000_000, &plain_mint(8), 1_000).unwrap_err();
    assert!(
        format!("{err:?}").contains("ScaledUiExtensionMissing"),
        "expected ScaledUiExtensionMissing, got {err:?}"
    );
}

/// The symmetric case, and the one the live wrappers present: the spec calls
/// Ondo FIXED, and the mint carries a live Scaled UI config. Registering it as
/// FIXED must fail loudly rather than under-count NAV forever.
#[test]
fn fixed_config_on_a_scaled_ui_mint_errors() {
    let w = wrapper(MultiplierSource::Fixed, 9);
    let data = scaled_ui_mint(9, 1.0017152488, 1.0017152488, 0);

    let err = wrapper_units(&w, 100 * 1_000_000_000, &data, 1_000).unwrap_err();
    assert!(
        format!("{err:?}").contains("ScaledUiConfigMismatch"),
        "expected ScaledUiConfigMismatch, got {err:?}"
    );
    let _ = QuorumError::ScaledUiConfigMismatch;
}

/// Ondo's SPYon multiplier, the largest live one on mainnet. A 0.95% error on a
/// six-figure position is real money.
#[test]
fn ondo_spyon_multiplier_matters_at_size() {
    let w = wrapper(MultiplierSource::Token2022ScaledUi, 9);
    let data = scaled_ui_mint(9, 1.0094730728, 1.0094730728, 0);

    let units = wrapper_units(&w, 1_000 * 1_000_000_000, &data, 1_000).unwrap();
    let naive_raw = 1_000 * UNITS_SCALE;

    assert_eq!(units, 1_009_473_072_800);
    // Nearly 9.5 shares unaccounted for on a 1,000 share position.
    assert!(units - naive_raw > 9 * UNITS_SCALE);
}
