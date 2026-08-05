use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::app_gocardless::{
    bank_factory,
    banks::{
        abanca_caglesmm, abnamro_abnanl2a, american_express_aesudef1, bancsabadell_bsabesbbb,
        bank_of_ireland_b365_bofiie2d, bankinter_bkbkesmm, belfius_gkccbebb,
        berliner_sparkasse_beladebexxx, bnp_be_gebabebb, boursobank_bousfrppxxx,
        bper_retail_bpmoit22, cbc_cregbebb, cetelem_cetmptp1xxx, commerzbank_cobadeff,
        danskebank_privat, direkt_heladef1822, easybank_bawaatww, entercard_swednokk,
        fortuneo_ftnofrp1xxx, hype_hyeeit22, ing_ingbrobu, ing_ingddeff, ing_pl_ingbplpw,
        integration_bank, isybank_itbbitmm, kbc_kredbebb, lhv_lhvbee22, mbank_retail_brexplpw,
        nationwide_naiagb21, nbg_ethngraaxxx, norwegian_xx_norwnok1, raiffeisen_at_rzbaatww,
        revolut_revolt21, sandboxfinance_sfin0000, seb_kort_bank_ab, seb_privat, sparnord_spnodk22,
        spk_karlsruhe_karsde66, spk_marburg_biedenkopf_heladef1mar,
        spk_worms_alzey_ried_malade51wor, ssk_dusseldorf_dussdeddxxx, ssk_munchen,
        swedbank_habalv22, virgin_nrnbgb22,
    },
};

fn source_module_pairs() -> BTreeMap<&'static str, &'static str> {
    let mut pairs = BTreeMap::new();
    macro_rules! add {
        ($module:ident) => {
            for institution_id in $module::INSTITUTION_IDS {
                assert!(pairs.insert(*institution_id, stringify!($module)).is_none());
            }
        };
    }
    add!(abanca_caglesmm);
    add!(abnamro_abnanl2a);
    add!(american_express_aesudef1);
    add!(bancsabadell_bsabesbbb);
    add!(bank_of_ireland_b365_bofiie2d);
    add!(bankinter_bkbkesmm);
    add!(belfius_gkccbebb);
    add!(berliner_sparkasse_beladebexxx);
    add!(bnp_be_gebabebb);
    add!(boursobank_bousfrppxxx);
    add!(bper_retail_bpmoit22);
    add!(cbc_cregbebb);
    add!(cetelem_cetmptp1xxx);
    add!(commerzbank_cobadeff);
    add!(danskebank_privat);
    add!(direkt_heladef1822);
    add!(easybank_bawaatww);
    add!(entercard_swednokk);
    add!(fortuneo_ftnofrp1xxx);
    add!(hype_hyeeit22);
    add!(ing_ingbrobu);
    add!(ing_ingddeff);
    add!(ing_pl_ingbplpw);
    add!(isybank_itbbitmm);
    add!(kbc_kredbebb);
    add!(lhv_lhvbee22);
    add!(mbank_retail_brexplpw);
    add!(nationwide_naiagb21);
    add!(nbg_ethngraaxxx);
    add!(norwegian_xx_norwnok1);
    add!(raiffeisen_at_rzbaatww);
    add!(revolut_revolt21);
    add!(sandboxfinance_sfin0000);
    add!(seb_kort_bank_ab);
    add!(seb_privat);
    add!(sparnord_spnodk22);
    add!(spk_karlsruhe_karsde66);
    add!(spk_marburg_biedenkopf_heladef1mar);
    add!(spk_worms_alzey_ried_malade51wor);
    add!(ssk_dusseldorf_dussdeddxxx);
    add!(ssk_munchen);
    add!(swedbank_habalv22);
    add!(virgin_nrnbgb22);
    pairs
}

fn source_institution_ids() -> Vec<&'static str> {
    source_module_pairs().into_keys().collect()
}

fn assert_authoritative_fixture() {
    let fixture: BTreeMap<String, String> = serde_json::from_str(include_str!(
        "../../../src/app-gocardless/tests/fixtures/gocardless-bank-modules.json"
    ))
    .unwrap();
    assert_eq!(fixture.len(), 79);
    assert_eq!(
        source_module_pairs(),
        fixture
            .iter()
            .map(|(institution_id, module)| (institution_id.as_str(), module.as_str()))
            .collect()
    );
}

#[test]
fn rust_modules_match_the_authoritative_typescript_fixture() {
    assert_authoritative_fixture();
}

// TypeScript's factory returns a module object, so its source test can compare
// object membership. Rust modules are namespaces and have no runtime identity.
// The equivalent observable contract is that every declared institution ID
// dispatches to the same normalizer result as its specialized module.
#[test]
fn every_known_institution_dispatches_to_its_specialized_transaction_normalizer() {
    assert_authoritative_fixture();
    let transaction = |remittance: Value| {
        json!({
            "transactionId": "D202401020000001", "internalTransactionId": "internal-transaction-id",
        "bookingDate": "2024-01-02", "bookingDateTime": "2024-01-02T12:00:00.000Z",
        "valueDate": "2024-01-03", "valueDateTime": "2024-01-03T12:00:00.000Z",
        "date": "1999-01-01",
            "transactionAmount": { "amount": "100.00", "currency": "EUR" },
        "creditorName": "CREDITOR;NAME", "debtorName": "DEBTOR;NAME", "ultimateCreditor": "ULTIMATE CREDITOR",
            "remittanceInformationUnstructured": remittance,
            "remittanceInformationUnstructuredArray": ["BEA, Betaalpas", "CCV*Other payee name,PAS123", "NR:123A4B, 09.12.23/15:43", "CITY"],
            "remittanceInformationStructured": "structured remittance", "remittanceInformationStructuredArray": ["structured", "remittance"],
            "additionalInformation": "additional information", "bankTransactionCode": "PMNT-CCRD-POSD"
        })
    };
    let mut probes = [
        "ordinary remittance",
        "mandatereference:,creditorid:,remittanceinformation:Extracted ING notes",
        "Bizum payment from: DEBTOR NAME",
        "FPS, Joe Bloggs, Food",
        "(..1234) 2025-01-02 09:32 CrustumOU\\Address",
        "PIRKUMS 424242******4242 28.10.2024 22.99 EUR (111111) SOME CREDITOR NAME",
        "PIRKUMS 424242******4242 28.10.24 13:37 22.99 EUR (111111) SOME CREDITOR NAME",
        "VIR INST Some Payee Name MOTIF Payment notes",
        "CARTE 1234 SHOP NAME 01/02",
        "Some info 31.12.23 12:34 Merchant\\Address",
        "POS12JAN Some Merchant SEPA DD",
        "BONIFICO O/C: JOHN DOE ABI 12345",
        "Payment notes\nEndToEndID: NOTPROVIDED",
    ]
    .map(|remittance| transaction(json!(remittance)))
    .to_vec();
    let mut missing_creditor = transaction(json!("ordinary remittance"));
    missing_creditor["creditorName"] = Value::Null;
    missing_creditor["debtorName"] = Value::Null;
    missing_creditor["transactionAmount"]["amount"] = json!("-100.00");
    missing_creditor["additionalInformation"] =
        json!("atmPosName: SPECIAL ATM, narrative: ['SPECIAL NARRATIVE']");
    probes.push(missing_creditor);
    let mut missing_unstructured = transaction(Value::Null);
    missing_unstructured["remittanceInformationStructured"] = json!("structured fallback");
    probes.push(missing_unstructured);
    let mut missing_provider_id = transaction(json!("Merchant, card no: xxxx1234"));
    missing_provider_id["transactionId"] = json!("NOTPROVIDED");
    probes.push(missing_provider_id);
    let mut pending_greek_purchase = transaction(json!("ΑΓΟΡΑ MERCHANT"));
    pending_greek_purchase
        .as_object_mut()
        .unwrap()
        .remove("transactionId");
    probes.push(pending_greek_purchase);
    let mut bizum = transaction(json!("ordinary remittance"));
    bizum["remittanceInformationUnstructuredArray"] =
        json!(["Bizum payment from: DEBTOR NAME", "Bizum description"]);
    probes.push(bizum);

    macro_rules! plain {
        ($module:ident) => {
            for institution_id in $module::INSTITUTION_IDS {
                for booked in [false, true] {
                    let mut differs_from_default = false;
                    for transaction in &probes {
                        let actual = bank_factory::normalize_transaction(institution_id, transaction, booked);
                        let direct = $module::normalize_transaction(transaction);
                        assert_eq!(actual, direct, "transaction dispatch mismatch for {institution_id}, booked={booked}");
                        differs_from_default |= actual != integration_bank::normalize_transaction(transaction);
                    }
                    assert!(differs_from_default, "transaction probe did not distinguish {institution_id}, booked={booked} from default");
                }
            }
        };
    }
    macro_rules! booked {
        ($module:ident) => {
            for institution_id in $module::INSTITUTION_IDS {
                for booked in [false, true] {
                    let mut differs_from_default = false;
                    for transaction in &probes {
                        let actual = bank_factory::normalize_transaction(institution_id, transaction, booked);
                        let direct = $module::normalize_transaction(transaction, booked);
                        assert_eq!(actual, direct, "transaction dispatch mismatch for {institution_id}, booked={booked}");
                        differs_from_default |= actual != integration_bank::normalize_transaction(transaction);
                    }
                    assert!(differs_from_default, "transaction probe did not distinguish {institution_id}, booked={booked} from default");
                }
            }
        };
    }

    plain!(abanca_caglesmm);
    plain!(abnamro_abnanl2a);
    plain!(bancsabadell_bsabesbbb);
    plain!(bank_of_ireland_b365_bofiie2d);
    plain!(bankinter_bkbkesmm);
    plain!(belfius_gkccbebb);
    plain!(berliner_sparkasse_beladebexxx);
    plain!(bnp_be_gebabebb);
    plain!(boursobank_bousfrppxxx);
    plain!(bper_retail_bpmoit22);
    plain!(cbc_cregbebb);
    plain!(cetelem_cetmptp1xxx);
    plain!(commerzbank_cobadeff);
    plain!(danskebank_privat);
    plain!(direkt_heladef1822);
    plain!(easybank_bawaatww);
    plain!(entercard_swednokk);
    plain!(fortuneo_ftnofrp1xxx);
    plain!(hype_hyeeit22);
    booked!(ing_ingbrobu);
    plain!(ing_ingddeff);
    plain!(ing_pl_ingbplpw);
    plain!(isybank_itbbitmm);
    plain!(kbc_kredbebb);
    booked!(lhv_lhvbee22);
    plain!(mbank_retail_brexplpw);
    booked!(nationwide_naiagb21);
    plain!(nbg_ethngraaxxx);
    booked!(norwegian_xx_norwnok1);
    plain!(raiffeisen_at_rzbaatww);
    plain!(revolut_revolt21);
    plain!(seb_kort_bank_ab);
    plain!(seb_privat);
    plain!(sparnord_spnodk22);
    plain!(spk_karlsruhe_karsde66);
    plain!(spk_marburg_biedenkopf_heladef1mar);
    plain!(spk_worms_alzey_ried_malade51wor);
    booked!(ssk_dusseldorf_dussdeddxxx);
    plain!(ssk_munchen);
    booked!(swedbank_habalv22);
    plain!(virgin_nrnbgb22);
}

#[test]
fn specialized_account_and_default_dispatch_match_their_rust_normalizers() {
    let account = json!({
        "id": "account-id",
        "institution_id": "AMERICAN_EXPRESS_AESUDEF1",
        "iban": "DE001234",
        "name": "Checking",
        "currency": "EUR",
        "institution": { "id": "AMERICAN_EXPRESS_AESUDEF1" }
    });
    for institution_id in american_express_aesudef1::INSTITUTION_IDS {
        assert_eq!(
            bank_factory::normalize_account(institution_id, account.as_object().unwrap()),
            american_express_aesudef1::normalize_account(account.as_object().unwrap())
        );
    }
    for institution_id in source_institution_ids() {
        if !american_express_aesudef1::INSTITUTION_IDS.contains(&institution_id) {
            assert_eq!(
                bank_factory::normalize_account(institution_id, account.as_object().unwrap()),
                integration_bank::normalize_account(account.as_object().unwrap()),
                "default account dispatch mismatch for {institution_id}"
            );
        }
    }

    let sparse_account = json!({
        "id": "sparse-account",
        "institution_id": "BANK",
        "iban": null,
        "name": null,
        "displayName": null,
        "product": null,
        "currency": null,
        "institution": null
    });
    for institution_id in source_institution_ids() {
        let expected = if american_express_aesudef1::INSTITUTION_IDS.contains(&institution_id) {
            american_express_aesudef1::normalize_account(sparse_account.as_object().unwrap())
        } else {
            integration_bank::normalize_account(sparse_account.as_object().unwrap())
        };
        assert_eq!(
            bank_factory::normalize_account(institution_id, sparse_account.as_object().unwrap()),
            expected,
            "null/optional account dispatch mismatch for {institution_id}"
        );
    }

    let transaction = json!({
        "bookingDate": "2024-01-02",
        "transactionAmount": { "amount": "1.00", "currency": "EUR" }
    });
    for institution_id in american_express_aesudef1::INSTITUTION_IDS
        .iter()
        .chain(sandboxfinance_sfin0000::INSTITUTION_IDS)
    {
        assert_eq!(
            bank_factory::normalize_transaction(institution_id, &transaction, true),
            integration_bank::normalize_transaction(&transaction),
            "default transaction dispatch mismatch for {institution_id}"
        );
    }
    assert_eq!(
        bank_factory::normalize_transaction("fake-id-not-found", &transaction, true),
        integration_bank::normalize_transaction(&transaction)
    );
    assert_eq!(
        bank_factory::normalize_account("fake-id-not-found", account.as_object().unwrap()),
        integration_bank::normalize_account(account.as_object().unwrap())
    );
    for unknown in [
        "",
        "IntegrationBank",
        "abnamro_abnanl2a",
        "fake-id-not-found",
    ] {
        assert_eq!(
            bank_factory::normalize_transaction(unknown, &Value::Null, true),
            None,
            "malformed default transaction should be omitted for {unknown:?}"
        );
        assert_eq!(
            bank_factory::normalize_account(unknown, sparse_account.as_object().unwrap()),
            integration_bank::normalize_account(sparse_account.as_object().unwrap()),
            "unknown/default account mismatch for {unknown:?}"
        );
        let mut via_factory = vec![
            json!({ "bookingDate": null, "valueDate": "2024-01-01" }),
            json!({ "bookingDate": "2024-02-01", "valueDate": null }),
        ];
        let mut direct = via_factory.clone();
        bank_factory::sort_transactions(unknown, &mut via_factory);
        integration_bank::sort_transactions(&mut direct);
        assert_eq!(via_factory, direct, "unknown/default sort mismatch");
        assert_eq!(
            bank_factory::calculate_starting_balance(unknown, &[], &[]),
            integration_bank::calculate_starting_balance(&[], &[]),
            "unknown/default balance mismatch"
        );
    }
    let mut factory_sorted = vec![
        json!({ "bookingDate": "2024-01-01" }),
        json!({ "bookingDate": "2024-01-02" }),
    ];
    let mut default_sorted = factory_sorted.clone();
    bank_factory::sort_transactions("fake-id-not-found", &mut factory_sorted);
    integration_bank::sort_transactions(&mut default_sorted);
    assert_eq!(factory_sorted, default_sorted);
    let transactions = [json!({ "transactionAmount": { "amount": "25.00" } })];
    let balances =
        [json!({ "balanceType": "closingBooked", "balanceAmount": { "amount": "100.00" } })];
    assert_eq!(
        bank_factory::calculate_starting_balance("fake-id-not-found", &transactions, &balances),
        integration_bank::calculate_starting_balance(&transactions, &balances)
    );
}

#[test]
fn provider_specific_sort_and_balance_dispatch_match_direct_implementations() {
    macro_rules! sort {
        ($module:ident, $transactions:expr) => {
            for institution_id in $module::INSTITUTION_IDS {
                let mut via_factory = $transactions;
                let mut direct = via_factory.clone();
                let mut default = via_factory.clone();
                bank_factory::sort_transactions(institution_id, &mut via_factory);
                $module::sort_transactions(&mut direct);
                integration_bank::sort_transactions(&mut default);
                assert_eq!(
                    via_factory, direct,
                    "sort dispatch mismatch for {institution_id}"
                );
                assert_ne!(
                    via_factory, default,
                    "sort probe did not distinguish {institution_id} from default"
                );
            }
        };
    }
    sort!(
        abnamro_abnanl2a,
        vec![
            json!({ "bookingDate": "2024-02-01", "valueDateTime": "2024-01-01T00:00:00Z" }),
            json!({ "bookingDate": "2024-01-01", "valueDateTime": "2024-02-01T00:00:00Z" }),
        ]
    );
    sort!(
        easybank_bawaatww,
        vec![
            json!({ "transactionId": "1", "bookingDate": "2024-01-01", "valueDate": "2024-01-01" }),
            json!({ "transactionId": "2", "bookingDate": "2024-01-01", "valueDate": "2024-01-01" }),
        ]
    );
    sort!(
        ing_ingddeff,
        vec![
            json!({ "transactionId": "1", "bookingDate": "2024-02-01", "valueDate": "2024-01-01" }),
            json!({ "transactionId": "2", "bookingDate": "2024-01-01", "valueDate": "2024-02-01" }),
        ]
    );
    sort!(
        ing_pl_ingbplpw,
        vec![
            json!({ "transactionId": "D202301010000001", "bookingDate": "2024-01-01" }),
            json!({ "transactionId": "D202401010000001", "bookingDate": "2024-01-01" }),
        ]
    );
    sort!(
        mbank_retail_brexplpw,
        vec![
            json!({ "transactionId": "1", "bookingDate": "2024-01-01" }),
            json!({ "transactionId": "2", "bookingDate": "2024-01-01" }),
        ]
    );

    let specialized_sort_ids = [
        abnamro_abnanl2a::INSTITUTION_IDS,
        easybank_bawaatww::INSTITUTION_IDS,
        ing_ingddeff::INSTITUTION_IDS,
        ing_pl_ingbplpw::INSTITUTION_IDS,
        mbank_retail_brexplpw::INSTITUTION_IDS,
    ]
    .concat();
    for institution_id in source_institution_ids() {
        if !specialized_sort_ids.contains(&institution_id) {
            let mut via_factory = vec![
                json!({ "bookingDate": null, "valueDate": "2024-01-01" }),
                json!({ "bookingDate": "2024-02-01", "valueDate": null }),
            ];
            let mut direct = via_factory.clone();
            bank_factory::sort_transactions(institution_id, &mut via_factory);
            integration_bank::sort_transactions(&mut direct);
            assert_eq!(
                via_factory, direct,
                "default sort dispatch mismatch for {institution_id}"
            );
        }
    }

    let transactions = [json!({
        "transactionAmount": { "amount": "25.00" },
        "balanceAfterTransaction": { "balanceAmount": { "amount": "888.88" } }
    })];
    let balances = [
        json!({ "balanceType": "firstOnly", "balanceAmount": { "amount": "8000.00" } }),
        json!({ "balanceType": "closingBooked", "balanceAmount": { "amount": "1000.00" } }),
        json!({ "balanceType": "expected", "balanceAmount": { "amount": "2000.00" } }),
        json!({ "balanceType": "forwardAvailable", "balanceAmount": { "amount": "3000.00" } }),
        json!({ "balanceType": "interimAvailable", "balanceAmount": { "amount": "4000.00" } }),
        json!({ "balanceType": "interimBooked", "balanceAmount": { "amount": "5000.00" } }),
        json!({ "balanceType": "nonInvoiced", "balanceAmount": { "amount": "6000.00" } }),
        json!({ "balanceType": "openingBooked", "balanceAmount": { "amount": "7000.00" } }),
        json!({ "balanceType": "information", "balanceAmount": { "amount": "9000.00" } }),
    ];
    macro_rules! balance {
        ($module:ident) => {
            for institution_id in $module::INSTITUTION_IDS {
                assert_eq!(
                    bank_factory::calculate_starting_balance(
                        institution_id,
                        &transactions,
                        &balances
                    ),
                    $module::calculate_starting_balance(&transactions, &balances),
                    "balance dispatch mismatch for {institution_id}"
                );
                assert_ne!(
                    bank_factory::calculate_starting_balance(
                        institution_id,
                        &transactions,
                        &balances
                    ),
                    integration_bank::calculate_starting_balance(&transactions, &balances),
                    "balance probe did not distinguish {institution_id} from default"
                );
            }
        };
    }
    balance!(abnamro_abnanl2a);
    balance!(american_express_aesudef1);
    balance!(berliner_sparkasse_beladebexxx);
    balance!(danskebank_privat);
    balance!(entercard_swednokk);
    balance!(ing_ingddeff);
    balance!(ing_pl_ingbplpw);
    balance!(mbank_retail_brexplpw);
    balance!(nbg_ethngraaxxx);
    balance!(norwegian_xx_norwnok1);
    balance!(sandboxfinance_sfin0000);
    balance!(seb_kort_bank_ab);
    balance!(seb_privat);
    balance!(spk_karlsruhe_karsde66);
    balance!(ssk_munchen);

    let specialized_balance_ids = [
        abnamro_abnanl2a::INSTITUTION_IDS,
        american_express_aesudef1::INSTITUTION_IDS,
        berliner_sparkasse_beladebexxx::INSTITUTION_IDS,
        danskebank_privat::INSTITUTION_IDS,
        entercard_swednokk::INSTITUTION_IDS,
        ing_ingddeff::INSTITUTION_IDS,
        ing_pl_ingbplpw::INSTITUTION_IDS,
        mbank_retail_brexplpw::INSTITUTION_IDS,
        nbg_ethngraaxxx::INSTITUTION_IDS,
        norwegian_xx_norwnok1::INSTITUTION_IDS,
        sandboxfinance_sfin0000::INSTITUTION_IDS,
        seb_kort_bank_ab::INSTITUTION_IDS,
        seb_privat::INSTITUTION_IDS,
        spk_karlsruhe_karsde66::INSTITUTION_IDS,
        ssk_munchen::INSTITUTION_IDS,
    ]
    .concat();
    for institution_id in source_institution_ids() {
        if !specialized_balance_ids.contains(&institution_id) {
            assert_eq!(
                bank_factory::calculate_starting_balance(institution_id, &transactions, &balances),
                integration_bank::calculate_starting_balance(&transactions, &balances),
                "default balance dispatch mismatch for {institution_id}"
            );
        }
    }
}
