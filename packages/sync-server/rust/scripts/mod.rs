pub mod disable_openid;
pub mod enable_openid;
pub mod health_check;
pub mod reset_password;
pub mod run_migrations;

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{
    app::{AppState, GlobalRateLimiter},
    app_account::AuthRateLimiter,
    app_cors_proxy::CorsProxyState,
    app_enablebanking::EnableBankingState,
    app_gocardless::services::gocardless_service::GoCardlessService,
    app_openid::OpenIdConfigRateLimiter,
    app_pluggyai::pluggyai_service::PluggyAiService,
    db::open_database,
    load_config::Config,
    util::http::with_node_extra_ca,
};

pub(crate) fn app_state(config: Config) -> Result<AppState, String> {
    let database = open_database(&config.server_files.join("account.sqlite"))
        .map_err(|error| error.to_string())?;
    let http = with_node_extra_ca(reqwest::Client::builder())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;

    Ok(AppState {
        database: Arc::new(Mutex::new(database)),
        config: Arc::new(config),
        http,
        auth_rate_limiter: AuthRateLimiter::default(),
        openid_config_rate_limiter: OpenIdConfigRateLimiter::default(),
        gocardless: GoCardlessService::default(),
        pluggyai: PluggyAiService::default(),
        akahu_refresh: Arc::new(tokio::sync::Mutex::new(())),
        cors_proxy: CorsProxyState::new()?,
        enablebanking: EnableBankingState::default(),
        started_at: Instant::now(),
        global_rate_limiter: GlobalRateLimiter::default(),
    })
}

pub fn invalid_config_exit(error: String) -> (u8, String) {
    (1, error)
}

#[cfg(test)]
mod tests {
    #[test]
    fn invalid_cli_configuration_exits_with_usage_status() {
        assert_eq!(
            super::invalid_config_exit("invalid config".into()),
            (1, "invalid config".into())
        );
    }
}
