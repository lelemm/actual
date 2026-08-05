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
    Seconds(f64),
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
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if Path::new("/data").exists() {
                PathBuf::from("/data")
            } else {
                project_root.clone()
            }
        });
    let mut value = default_value(&project_root, &default_data_dir, &environment);
    apply_port_default(&mut value, env::var("PORT").ok());
    let config_path = env::var_os("ACTUAL_CONFIG_PATH")
        .filter(|value| !value.is_empty())
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
    coerce_loaded_values(&mut value)?;
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

fn apply_port_default(value: &mut Value, port: Option<String>) {
    if let Some(port) = port.filter(|port| !port.is_empty()) {
        value["port"] = Value::String(port);
    }
}

fn coerce_loaded_values(value: &mut Value) -> Result<(), String> {
    for path in [
        &["port"][..],
        &["upload", "fileSizeSyncLimitMB"],
        &["upload", "syncEncryptedFileSizeLimitMB"],
        &["upload", "fileSizeLimitMB"],
    ] {
        coerce_integer(value, path)?;
    }
    for path in [
        &["allowedLoginMethods"][..],
        &["trustedProxies"],
        &["trustedAuthProxies"],
    ] {
        coerce_string(value, path, array)?;
    }
    for path in [&["enforceOpenId"][..], &["corsProxy", "enabled"]] {
        coerce_string(value, path, boolean)?;
    }
    coerce_string(value, &["token_expiration"], token_expiration)
}

fn coerce_integer(value: &mut Value, path: &[&str]) -> Result<(), String> {
    coerce_integer_number(value, path)?;
    coerce_string(value, path, number)
}

fn coerce_integer_number(value: &mut Value, path: &[&str]) -> Result<(), String> {
    let Some(target) = value_at_mut(value, path) else {
        return Ok(());
    };
    if let Value::Number(number) = target
        && number.as_u64().is_none()
        && let Some(number) = number
            .as_f64()
            .filter(|number| number.is_finite() && *number >= 0.0 && number.fract() == 0.0)
            .filter(|number| *number <= u64::MAX as f64)
    {
        *target = json!(number as u64);
    }
    Ok(())
}

fn coerce_string(
    value: &mut Value,
    path: &[&str],
    parse: fn(String) -> Result<Value, String>,
) -> Result<(), String> {
    let Some(target) = value_at_mut(value, path) else {
        return Ok(());
    };
    if let Value::String(raw) = target {
        *target = parse(std::mem::take(raw))?;
    }
    Ok(())
}

fn value_at_mut<'a>(value: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    let mut target = value;
    for key in path {
        let next = target.get_mut(*key)?;
        target = next;
    }
    Some(target)
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
    let value = value.trim_start();
    let (is_negative, value) = match value.as_bytes().first() {
        Some(b'-') => (true, &value[1..]),
        Some(b'+') => (false, &value[1..]),
        _ => (false, value),
    };
    let digits = value
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let value = value
        .get(..digits)
        .ok_or_else(|| "Invalid non-negative integer".to_owned())?;
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("Invalid non-negative integer: {value}"))?;
    if is_negative && parsed != 0 {
        return Err(format!("Invalid non-negative integer: -{value}"));
    }
    Ok(Value::Number(parsed.into()))
}

fn boolean(value: String) -> Result<Value, String> {
    Ok(Value::Bool(!value.eq_ignore_ascii_case("false")))
}

fn array(value: String) -> Result<Value, String> {
    Ok(Value::Array(
        value
            .split(',')
            .map(|value| Value::String(value.to_owned()))
            .collect(),
    ))
}

fn token_expiration(value: String) -> Result<Value, String> {
    if matches!(value.as_str(), "never" | "openid-provider") {
        return Ok(Value::String(value));
    }
    let value = value.trim();
    if value.is_empty() {
        return Ok(json!(0));
    }
    let parsed = match [(("0x", "0X"), 16), (("0o", "0O"), 8), (("0b", "0B"), 2)]
        .into_iter()
        .find_map(|((lower, upper), radix)| {
            value
                .strip_prefix(lower)
                .or_else(|| value.strip_prefix(upper))
                .map(|value| (value, radix))
        }) {
        Some((value, radix)) if !value.is_empty() => {
            num_bigint::BigUint::parse_bytes(value.as_bytes(), radix)
                .and_then(|number| number.to_str_radix(10).parse::<f64>().ok())
        }
        Some(_) => None,
        None => value.parse::<f64>().ok(),
    };
    parsed
        .filter(|value| value.is_finite() && *value >= 0.0)
        .and_then(serde_json::Number::from_f64)
        .map(Value::Number)
        .ok_or_else(|| format!("Invalid token_expiration value: {value}"))
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
    if let TokenExpiration::Seconds(value) = config.token_expiration
        && (!value.is_finite() || value < 0.0)
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
        for (value, expected) in [
            ("86400", 86400.0),
            ("1e3", 1000.0),
            ("0x10", 16.0),
            ("0x24ded6a2c8489d3", 166_049_801_551_776_220.0),
            ("0b10", 2.0),
            ("0o10", 8.0),
            ("0.5", 0.5),
            (" ", 0.0),
        ] {
            assert_eq!(
                token_expiration(value.into()).unwrap().as_f64(),
                Some(expected)
            );
        }
        assert_eq!(token_expiration("never".into()).unwrap(), json!("never"));
        assert_eq!(
            token_expiration("openid-provider".into()).unwrap(),
            json!("openid-provider")
        );
        assert!(token_expiration("60minutes".into()).is_err());
        assert!(token_expiration("-1".into()).is_err());
        assert!(token_expiration("Infinity".into()).is_err());
        assert!(token_expiration("1e309".into()).is_err());
        for value in ["0x", "0X", "0o", "0O", "0b", "0B"] {
            assert!(token_expiration(value.into()).is_err());
        }
    }

    #[test]
    fn coerces_values_like_convict() {
        assert_eq!(number("  +20MB".into()).unwrap(), json!(20));
        assert_eq!(number("1e2".into()).unwrap(), json!(1));
        assert_eq!(number("-0".into()).unwrap(), json!(0));
        assert!(number("-1".into()).is_err());
        assert_eq!(boolean("FALSE".into()).unwrap(), json!(false));
        assert_eq!(boolean("0".into()).unwrap(), json!(true));
        assert_eq!(
            array("password, header".into()).unwrap(),
            json!(["password", " header"])
        );
    }

    #[test]
    fn coerces_string_values_loaded_from_config_files() {
        let mut value = default_value(Path::new("/tmp/project"), Path::new("/tmp/data"), "test");
        value["port"] = json!(5007.0);
        value["upload"]["fileSizeLimitMB"] = json!("21MB");
        value["enforceOpenId"] = json!("0");
        value["allowedLoginMethods"] = json!("password,header");
        value["token_expiration"] = json!("6e1");

        coerce_loaded_values(&mut value).unwrap();
        let config = from_value(value).unwrap();

        assert_eq!(config.port, 5007);
        assert_eq!(config.upload.file_size_limit_mb, 21);
        assert!(config.enforce_open_id);
        assert_eq!(config.allowed_login_methods, ["password", "header"]);
        assert!(matches!(
            config.token_expiration,
            TokenExpiration::Seconds(60.0)
        ));
    }

    #[test]
    fn legacy_port_is_only_a_default() {
        let mut value = default_value(Path::new("/tmp/project"), Path::new("/tmp/data"), "test");
        apply_port_default(&mut value, Some("5007".into()));
        assert_eq!(value["port"], json!("5007"));

        merge(&mut value, json!({ "port": 5008 }));
        assert_eq!(value["port"], json!(5008));
    }

    #[test]
    fn rejects_unknown_configuration_keys() {
        let mut value = default_value(Path::new("/tmp/project"), Path::new("/tmp/data"), "test");
        value["unknown"] = json!(true);
        assert!(from_value(value).is_err());
    }
}
