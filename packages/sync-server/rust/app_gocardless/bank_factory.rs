use serde_json::{Map, Value};

use super::banks::{
    abanca_caglesmm, abnamro_abnanl2a, american_express_aesudef1, bancsabadell_bsabesbbb,
    bank_of_ireland_b365_bofiie2d, bankinter_bkbkesmm, belfius_gkccbebb,
    berliner_sparkasse_beladebexxx, bnp_be_gebabebb, boursobank_bousfrppxxx, bper_retail_bpmoit22,
    cbc_cregbebb, cetelem_cetmptp1xxx, commerzbank_cobadeff, danskebank_privat, direkt_heladef1822,
    easybank_bawaatww, entercard_swednokk, fortuneo_ftnofrp1xxx, hype_hyeeit22, ing_ingbrobu,
    ing_ingddeff, ing_pl_ingbplpw, integration_bank, isybank_itbbitmm, kbc_kredbebb, lhv_lhvbee22,
    mbank_retail_brexplpw, nationwide_naiagb21, nbg_ethngraaxxx, norwegian_xx_norwnok1,
    raiffeisen_at_rzbaatww, revolut_revolt21, sandboxfinance_sfin0000, seb_kort_bank_ab,
    seb_privat, sparnord_spnodk22, spk_karlsruhe_karsde66, spk_marburg_biedenkopf_heladef1mar,
    spk_worms_alzey_ried_malade51wor, ssk_dusseldorf_dussdeddxxx, ssk_munchen, swedbank_habalv22,
    virgin_nrnbgb22,
};

pub fn normalize_account(institution_id: &str, account: &Map<String, Value>) -> Value {
    if american_express_aesudef1::INSTITUTION_IDS.contains(&institution_id) {
        american_express_aesudef1::normalize_account(account)
    } else {
        integration_bank::normalize_account(account)
    }
}

pub fn normalize_transaction(
    institution_id: &str,
    transaction: &Value,
    booked: bool,
) -> Option<Value> {
    if abanca_caglesmm::INSTITUTION_IDS.contains(&institution_id) {
        abanca_caglesmm::normalize_transaction(transaction)
    } else if abnamro_abnanl2a::INSTITUTION_IDS.contains(&institution_id) {
        abnamro_abnanl2a::normalize_transaction(transaction)
    } else if bancsabadell_bsabesbbb::INSTITUTION_IDS.contains(&institution_id) {
        bancsabadell_bsabesbbb::normalize_transaction(transaction)
    } else if bank_of_ireland_b365_bofiie2d::INSTITUTION_IDS.contains(&institution_id) {
        bank_of_ireland_b365_bofiie2d::normalize_transaction(transaction)
    } else if bankinter_bkbkesmm::INSTITUTION_IDS.contains(&institution_id) {
        bankinter_bkbkesmm::normalize_transaction(transaction)
    } else if belfius_gkccbebb::INSTITUTION_IDS.contains(&institution_id) {
        belfius_gkccbebb::normalize_transaction(transaction)
    } else if berliner_sparkasse_beladebexxx::INSTITUTION_IDS.contains(&institution_id) {
        berliner_sparkasse_beladebexxx::normalize_transaction(transaction)
    } else if bnp_be_gebabebb::INSTITUTION_IDS.contains(&institution_id) {
        bnp_be_gebabebb::normalize_transaction(transaction)
    } else if boursobank_bousfrppxxx::INSTITUTION_IDS.contains(&institution_id) {
        boursobank_bousfrppxxx::normalize_transaction(transaction)
    } else if bper_retail_bpmoit22::INSTITUTION_IDS.contains(&institution_id) {
        bper_retail_bpmoit22::normalize_transaction(transaction)
    } else if cetelem_cetmptp1xxx::INSTITUTION_IDS.contains(&institution_id) {
        cetelem_cetmptp1xxx::normalize_transaction(transaction)
    } else if cbc_cregbebb::INSTITUTION_IDS.contains(&institution_id) {
        cbc_cregbebb::normalize_transaction(transaction)
    } else if commerzbank_cobadeff::INSTITUTION_IDS.contains(&institution_id) {
        commerzbank_cobadeff::normalize_transaction(transaction)
    } else if danskebank_privat::INSTITUTION_IDS.contains(&institution_id) {
        danskebank_privat::normalize_transaction(transaction)
    } else if direkt_heladef1822::INSTITUTION_IDS.contains(&institution_id) {
        direkt_heladef1822::normalize_transaction(transaction)
    } else if easybank_bawaatww::INSTITUTION_IDS.contains(&institution_id) {
        easybank_bawaatww::normalize_transaction(transaction)
    } else if entercard_swednokk::INSTITUTION_IDS.contains(&institution_id) {
        entercard_swednokk::normalize_transaction(transaction)
    } else if fortuneo_ftnofrp1xxx::INSTITUTION_IDS.contains(&institution_id) {
        fortuneo_ftnofrp1xxx::normalize_transaction(transaction)
    } else if hype_hyeeit22::INSTITUTION_IDS.contains(&institution_id) {
        hype_hyeeit22::normalize_transaction(transaction)
    } else if ing_ingbrobu::INSTITUTION_IDS.contains(&institution_id) {
        ing_ingbrobu::normalize_transaction(transaction, booked)
    } else if ing_ingddeff::INSTITUTION_IDS.contains(&institution_id) {
        ing_ingddeff::normalize_transaction(transaction)
    } else if ing_pl_ingbplpw::INSTITUTION_IDS.contains(&institution_id) {
        ing_pl_ingbplpw::normalize_transaction(transaction)
    } else if isybank_itbbitmm::INSTITUTION_IDS.contains(&institution_id) {
        isybank_itbbitmm::normalize_transaction(transaction)
    } else if kbc_kredbebb::INSTITUTION_IDS.contains(&institution_id) {
        kbc_kredbebb::normalize_transaction(transaction)
    } else if lhv_lhvbee22::INSTITUTION_IDS.contains(&institution_id) {
        lhv_lhvbee22::normalize_transaction(transaction, booked)
    } else if mbank_retail_brexplpw::INSTITUTION_IDS.contains(&institution_id) {
        mbank_retail_brexplpw::normalize_transaction(transaction)
    } else if nationwide_naiagb21::INSTITUTION_IDS.contains(&institution_id) {
        nationwide_naiagb21::normalize_transaction(transaction, booked)
    } else if nbg_ethngraaxxx::INSTITUTION_IDS.contains(&institution_id) {
        nbg_ethngraaxxx::normalize_transaction(transaction)
    } else if norwegian_xx_norwnok1::INSTITUTION_IDS.contains(&institution_id) {
        norwegian_xx_norwnok1::normalize_transaction(transaction, booked)
    } else if raiffeisen_at_rzbaatww::INSTITUTION_IDS.contains(&institution_id) {
        raiffeisen_at_rzbaatww::normalize_transaction(transaction)
    } else if revolut_revolt21::INSTITUTION_IDS.contains(&institution_id) {
        revolut_revolt21::normalize_transaction(transaction)
    } else if seb_kort_bank_ab::INSTITUTION_IDS.contains(&institution_id) {
        seb_kort_bank_ab::normalize_transaction(transaction)
    } else if seb_privat::INSTITUTION_IDS.contains(&institution_id) {
        seb_privat::normalize_transaction(transaction)
    } else if sparnord_spnodk22::INSTITUTION_IDS.contains(&institution_id) {
        sparnord_spnodk22::normalize_transaction(transaction)
    } else if spk_karlsruhe_karsde66::INSTITUTION_IDS.contains(&institution_id) {
        spk_karlsruhe_karsde66::normalize_transaction(transaction)
    } else if spk_marburg_biedenkopf_heladef1mar::INSTITUTION_IDS.contains(&institution_id) {
        spk_marburg_biedenkopf_heladef1mar::normalize_transaction(transaction)
    } else if spk_worms_alzey_ried_malade51wor::INSTITUTION_IDS.contains(&institution_id) {
        spk_worms_alzey_ried_malade51wor::normalize_transaction(transaction)
    } else if ssk_dusseldorf_dussdeddxxx::INSTITUTION_IDS.contains(&institution_id) {
        ssk_dusseldorf_dussdeddxxx::normalize_transaction(transaction, booked)
    } else if ssk_munchen::INSTITUTION_IDS.contains(&institution_id) {
        ssk_munchen::normalize_transaction(transaction)
    } else if swedbank_habalv22::INSTITUTION_IDS.contains(&institution_id) {
        swedbank_habalv22::normalize_transaction(transaction, booked)
    } else if virgin_nrnbgb22::INSTITUTION_IDS.contains(&institution_id) {
        virgin_nrnbgb22::normalize_transaction(transaction)
    } else {
        integration_bank::normalize_transaction(transaction)
    }
}

pub fn sort_transactions(institution_id: &str, transactions: &mut [Value]) {
    if abnamro_abnanl2a::INSTITUTION_IDS.contains(&institution_id) {
        abnamro_abnanl2a::sort_transactions(transactions);
    } else if easybank_bawaatww::INSTITUTION_IDS.contains(&institution_id) {
        easybank_bawaatww::sort_transactions(transactions);
    } else if ing_ingddeff::INSTITUTION_IDS.contains(&institution_id) {
        ing_ingddeff::sort_transactions(transactions);
    } else if ing_pl_ingbplpw::INSTITUTION_IDS.contains(&institution_id) {
        ing_pl_ingbplpw::sort_transactions(transactions);
    } else if mbank_retail_brexplpw::INSTITUTION_IDS.contains(&institution_id) {
        mbank_retail_brexplpw::sort_transactions(transactions);
    } else {
        integration_bank::sort_transactions(transactions);
    }
}

pub fn calculate_starting_balance(
    institution_id: &str,
    transactions: &[Value],
    balances: &[Value],
) -> i64 {
    if abnamro_abnanl2a::INSTITUTION_IDS.contains(&institution_id) {
        abnamro_abnanl2a::calculate_starting_balance(transactions, balances)
    } else if american_express_aesudef1::INSTITUTION_IDS.contains(&institution_id) {
        american_express_aesudef1::calculate_starting_balance(transactions, balances)
    } else if berliner_sparkasse_beladebexxx::INSTITUTION_IDS.contains(&institution_id) {
        berliner_sparkasse_beladebexxx::calculate_starting_balance(transactions, balances)
    } else if danskebank_privat::INSTITUTION_IDS.contains(&institution_id) {
        danskebank_privat::calculate_starting_balance(transactions, balances)
    } else if entercard_swednokk::INSTITUTION_IDS.contains(&institution_id) {
        entercard_swednokk::calculate_starting_balance(transactions, balances)
    } else if ing_ingddeff::INSTITUTION_IDS.contains(&institution_id) {
        ing_ingddeff::calculate_starting_balance(transactions, balances)
    } else if ing_pl_ingbplpw::INSTITUTION_IDS.contains(&institution_id) {
        ing_pl_ingbplpw::calculate_starting_balance(transactions, balances)
    } else if mbank_retail_brexplpw::INSTITUTION_IDS.contains(&institution_id) {
        mbank_retail_brexplpw::calculate_starting_balance(transactions, balances)
    } else if nbg_ethngraaxxx::INSTITUTION_IDS.contains(&institution_id) {
        nbg_ethngraaxxx::calculate_starting_balance(transactions, balances)
    } else if norwegian_xx_norwnok1::INSTITUTION_IDS.contains(&institution_id) {
        norwegian_xx_norwnok1::calculate_starting_balance(transactions, balances)
    } else if sandboxfinance_sfin0000::INSTITUTION_IDS.contains(&institution_id) {
        sandboxfinance_sfin0000::calculate_starting_balance(transactions, balances)
    } else if seb_kort_bank_ab::INSTITUTION_IDS.contains(&institution_id) {
        seb_kort_bank_ab::calculate_starting_balance(transactions, balances)
    } else if seb_privat::INSTITUTION_IDS.contains(&institution_id) {
        seb_privat::calculate_starting_balance(transactions, balances)
    } else if spk_karlsruhe_karsde66::INSTITUTION_IDS.contains(&institution_id) {
        spk_karlsruhe_karsde66::calculate_starting_balance(transactions, balances)
    } else if ssk_munchen::INSTITUTION_IDS.contains(&institution_id) {
        ssk_munchen::calculate_starting_balance(transactions, balances)
    } else {
        integration_bank::calculate_starting_balance(transactions, balances)
    }
}
