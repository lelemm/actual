use std::{
    env, fs,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(skip, default = "default_address")]
    pub address: SocketAddr,
    #[serde(rename = "env")]
    pub environment: String,
    pub mode: String,
    pub project_root: PathBuf,
    pub data_dir: PathBuf,
    pub port: u16,
    pub hostname: String,
    pub server_files: PathBuf,
    pub user_files: PathBuf,
    pub web_root: PathBuf,
    pub login_method: String,
    pub allowed_login_methods: Vec<String>,
    pub trusted_proxies: Vec<String>,
    pub trusted_auth_proxies: Vec<String>,
    pub https: HttpsConfig,
    pub upload: UploadConfig,
    #[serde(rename = "openId")]
    pub open_id: OpenIdConfig,
    #[serde(rename = "token_expiration")]
    pub token_expiration: TokenExpiration,
    #[serde(rename = "enforceOpenId")]
    pub enforce_open_id: bool,
    pub user_creation_mode: String,
    pub github: GithubConfig,
    pub cors_proxy: CorsProxyConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HttpsConfig {
    pub key: String,
    pub cert: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadConfig {
    #[serde(rename = "fileSizeSyncLimitMB")]
    pub file_size_sync_limit_mb: u64,
    #[serde(rename = "syncEncryptedFileSizeLimitMB")]
    pub sync_encrypted_file_size_limit_mb: u64,
    #[serde(rename = "fileSizeLimitMB")]
    pub file_size_limit_mb: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenIdConfig {
    #[serde(rename = "discoveryURL")]
    pub discovery_url: String,
    pub issuer: OpenIdIssuer,
    #[serde(rename = "client_id")]
    pub client_id: String,
    #[serde(rename = "client_secret")]
    pub client_secret: String,
    #[serde(rename = "server_hostname")]
    pub server_hostname: String,
    pub auth_method: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpenIdIssuer {
    pub name: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub userinfo_endpoint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum TokenExpiration {
    Named(String),
    Seconds(u64),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GithubConfig {
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CorsProxyConfig {
    pub enabled: bool,
}

fn default_address() -> SocketAddr {
    SocketAddr::from(([0, 0, 0, 0], 5006))
}

impl Default for Config {
    fn default() -> Self {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        from_value(default_value(&project_root, &project_root, "development"))
            .expect("valid built-in configuration")
    }
}

pub fn load() -> Result<Config, String> {
    let environment = env::var("NODE_ENV").unwrap_or_else(|_| "development".into());
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let default_data_dir = env::var_os("ACTUAL_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if Path::new("/data").exists() {
                PathBuf::from("/data")
            } else {
                project_root.clone()
            }
        });
    let mut value = default_value(&project_root, &default_data_dir, &environment);
    let config_path = env::var_os("ACTUAL_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let project_config = project_root.join("config.json");
            if project_config.exists() {
                project_config
            } else {
                default_data_dir.join("config.json")
            }
        });
    if config_path.exists() {
        let file = fs::read_to_string(&config_path).map_err(|error| error.to_string())?;
        let file = serde_json::from_str(&file).map_err(|error| error.to_string())?;
        merge(&mut value, file);
    }
    apply_environment(&mut value)?;
    let config = from_value(value)?;
    validate(&config)?;
    Ok(config)
}

fn from_value(value: Value) -> Result<Config, String> {
    let mut config: Config = serde_json::from_value(value).map_err(|error| error.to_string())?;
    config.address = parse_address(&config.hostname, config.port)?;
    Ok(config)
}

fn default_value(project_root: &Path, data_dir: &Path, environment: &str) -> Value {
    let is_test = environment == "test";
    json!({
        "env": environment,
        "mode": if is_test { "test" } else { "development" },
        "projectRoot": project_root,
        "dataDir": if is_test { project_root } else { data_dir },
        "port": 5006,
        "hostname": "::",
        "serverFiles": if is_test { project_root.join("test-server-files") } else { data_dir.join("server-files") },
        "userFiles": if is_test { project_root.join("test-user-files") } else { data_dir.join("user-files") },
        "webRoot": project_root.parent().unwrap_or(project_root).join("desktop-client/build"),
        "loginMethod": "password",
        "allowedLoginMethods": ["password", "header", "openid"],
        "trustedProxies": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "::1/128"],
        "trustedAuthProxies": [],
        "https": { "key": "", "cert": "" },
        "upload": {
            "fileSizeSyncLimitMB": 20,
            "syncEncryptedFileSizeLimitMB": 50,
            "fileSizeLimitMB": 20
        },
        "openId": {
            "discoveryURL": "",
            "issuer": {
                "name": "",
                "authorization_endpoint": "",
                "token_endpoint": "",
                "userinfo_endpoint": ""
            },
            "client_id": "",
            "client_secret": "",
            "server_hostname": "",
            "authMethod": "openid"
        },
        "token_expiration": "never",
        "enforceOpenId": false,
        "userCreationMode": "manual",
        "github": { "token": "" },
        "corsProxy": { "enabled": false }
    })
}

fn merge(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                if let Some(target) = target.get_mut(&key) {
                    merge(target, value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        (target, source) => *target = source,
    }
}

fn apply_environment(value: &mut Value) -> Result<(), String> {
    set_env(value, &["env"], "NODE_ENV", string)?;
    set_env(value, &["dataDir"], "ACTUAL_DATA_DIR", string)?;
    set_env(value, &["port"], "ACTUAL_PORT", number)?;
    set_env(value, &["hostname"], "ACTUAL_HOSTNAME", string)?;
    set_env(value, &["serverFiles"], "ACTUAL_SERVER_FILES", string)?;
    set_env(value, &["userFiles"], "ACTUAL_USER_FILES", string)?;
    set_env(value, &["webRoot"], "ACTUAL_WEB_ROOT", string)?;
    set_env(value, &["loginMethod"], "ACTUAL_LOGIN_METHOD", string)?;
    set_env(
        value,
        &["allowedLoginMethods"],
        "ACTUAL_ALLOWED_LOGIN_METHODS",
        array,
    )?;
    set_env(value, &["trustedProxies"], "ACTUAL_TRUSTED_PROXIES", array)?;
    set_env(
        value,
        &["trustedAuthProxies"],
        "ACTUAL_TRUSTED_AUTH_PROXIES",
        array,
    )?;
    set_env(value, &["https", "key"], "ACTUAL_HTTPS_KEY", string)?;
    set_env(value, &["https", "cert"], "ACTUAL_HTTPS_CERT", string)?;
    set_env(
        value,
        &["upload", "fileSizeSyncLimitMB"],
        "ACTUAL_UPLOAD_FILE_SYNC_SIZE_LIMIT_MB",
        number,
    )?;
    set_env(
        value,
        &["upload", "syncEncryptedFileSizeLimitMB"],
        "ACTUAL_UPLOAD_SYNC_ENCRYPTED_FILE_SYNC_SIZE_LIMIT_MB",
        number,
    )?;
    set_env(
        value,
        &["upload", "fileSizeLimitMB"],
        "ACTUAL_UPLOAD_FILE_SIZE_LIMIT_MB",
        number,
    )?;
    set_env(
        value,
        &["openId", "discoveryURL"],
        "ACTUAL_OPENID_DISCOVERY_URL",
        string,
    )?;
    for (key, environment) in [
        ("name", "ACTUAL_OPENID_PROVIDER_NAME"),
        (
            "authorization_endpoint",
            "ACTUAL_OPENID_AUTHORIZATION_ENDPOINT",
        ),
        ("token_endpoint", "ACTUAL_OPENID_TOKEN_ENDPOINT"),
        ("userinfo_endpoint", "ACTUAL_OPENID_USERINFO_ENDPOINT"),
    ] {
        set_env(value, &["openId", "issuer", key], environment, string)?;
    }
    for (key, environment) in [
        ("client_id", "ACTUAL_OPENID_CLIENT_ID"),
        ("client_secret", "ACTUAL_OPENID_CLIENT_SECRET"),
        ("server_hostname", "ACTUAL_OPENID_SERVER_HOSTNAME"),
        ("authMethod", "ACTUAL_OPENID_AUTH_METHOD"),
    ] {
        set_env(value, &["openId", key], environment, string)?;
    }
    set_env(
        value,
        &["token_expiration"],
        "ACTUAL_TOKEN_EXPIRATION",
        token_expiration,
    )?;
    set_env(value, &["enforceOpenId"], "ACTUAL_OPENID_ENFORCE", boolean)?;
    set_env(
        value,
        &["userCreationMode"],
        "ACTUAL_USER_CREATION_MODE",
        string,
    )?;
    set_env(value, &["github", "token"], "ACTUAL_GITHUB_TOKEN", string)?;
    set_env(
        value,
        &["corsProxy", "enabled"],
        "ACTUAL_CORS_PROXY_ENABLED",
        boolean,
    )
}

fn set_env(
    value: &mut Value,
    path: &[&str],
    environment: &str,
    parse: fn(String) -> Result<Value, String>,
) -> Result<(), String> {
    let Ok(raw) = env::var(environment) else {
        return Ok(());
    };
    let mut target = value;
    for key in &path[..path.len() - 1] {
        target = target
            .get_mut(*key)
            .ok_or_else(|| format!("Unknown configuration key: {key}"))?;
    }
    target[path[path.len() - 1]] = parse(raw)?;
    Ok(())
}

fn string(value: String) -> Result<Value, String> {
    Ok(Value::String(value))
}

fn number(value: String) -> Result<Value, String> {
    value
        .parse::<u64>()
        .map(|value| Value::Number(value.into()))
        .map_err(|_| format!("Invalid non-negative integer: {value}"))
}

fn boolean(value: String) -> Result<Value, String> {
    match value.as_str() {
        "true" | "1" => Ok(Value::Bool(true)),
        "false" | "0" => Ok(Value::Bool(false)),
        _ => Err(format!("Invalid boolean: {value}")),
    }
}

fn array(value: String) -> Result<Value, String> {
    if value.trim_start().starts_with('[') {
        return serde_json::from_str(&value).map_err(|error| error.to_string());
    }
    Ok(Value::Array(
        value
            .split(',')
            .map(|value| Value::String(value.trim().to_owned()))
            .collect(),
    ))
}

fn token_expiration(value: String) -> Result<Value, String> {
    if matches!(value.as_str(), "never" | "openid-provider") {
        return Ok(Value::String(value));
    }
    number(value)
}

fn validate(config: &Config) -> Result<(), String> {
    if !matches!(
        config.environment.as_str(),
        "production" | "development" | "test"
    ) {
        return Err(format!("Invalid env: {}", config.environment));
    }
    if !matches!(config.mode.as_str(), "test" | "development") {
        return Err(format!("Invalid mode: {}", config.mode));
    }
    if !matches!(
        config.login_method.as_str(),
        "password" | "header" | "openid"
    ) {
        return Err(format!("Invalid loginMethod: {}", config.login_method));
    }
    if config
        .allowed_login_methods
        .iter()
        .any(|method| !matches!(method.as_str(), "password" | "header" | "openid"))
    {
        return Err("Invalid allowedLoginMethods".into());
    }
    if !matches!(config.open_id.auth_method.as_str(), "openid" | "oauth2") {
        return Err(format!(
            "Invalid OpenID authMethod: {}",
            config.open_id.auth_method
        ));
    }
    if let TokenExpiration::Named(value) = &config.token_expiration
        && !matches!(value.as_str(), "never" | "openid-provider")
    {
        return Err(format!("Invalid token_expiration value: {value}"));
    }
    if !matches!(config.user_creation_mode.as_str(), "manual" | "login") {
        return Err(format!(
            "Invalid userCreationMode: {}",
            config.user_creation_mode
        ));
    }
    Ok(())
}

fn parse_address(hostname: &str, port: u16) -> Result<SocketAddr, String> {
    if let Ok(address) = hostname.parse::<IpAddr>() {
        return Ok(SocketAddr::new(address, port));
    }
    (hostname, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| format!("Unable to resolve hostname: {hostname}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_and_ipv6_addresses() {
        assert_eq!(parse_address("127.0.0.1", 5006).unwrap().port(), 5006);
        assert!(parse_address("::", 5006).unwrap().is_ipv6());
    }

    #[test]
    fn parses_every_token_expiration_form() {
        assert_eq!(token_expiration("86400".into()).unwrap(), json!(86400));
        assert_eq!(token_expiration("never".into()).unwrap(), json!("never"));
        assert!(token_expiration("-1".into()).is_err());
    }

    #[test]
    fn rejects_unknown_configuration_keys() {
        let mut value = default_value(Path::new("/tmp/project"), Path::new("/tmp/data"), "test");
        value["unknown"] = json!(true);
        assert!(from_value(value).is_err());
    }
}
