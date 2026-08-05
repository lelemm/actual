fn main() {
    let node_version = std::env::var("ACTUAL_NODE_VERSION")
        .ok()
        .or_else(|| {
            std::process::Command::new("node")
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|version| version.trim().trim_start_matches('v').to_owned())
        })
        .unwrap_or_else(|| "22.0.0".to_owned());
    println!("cargo:rustc-env=ACTUAL_ORACLE_NODE_VERSION={node_version}");
    println!("cargo:rerun-if-env-changed=ACTUAL_NODE_VERSION");

    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc");
    // SAFETY: Cargo runs this build script as a single-threaded process before
    // prost-build reads PROTOC.
    unsafe { std::env::set_var("PROTOC", protoc) };

    let proto = "../crdt/src/proto/sync.proto";
    let mut config = prost_build::Config::new();
    config.default_package_filename("sync");
    config
        .compile_protos(&[proto], &["../crdt/src/proto"])
        .expect("compile shared sync protobuf schema");
    println!("cargo:rerun-if-changed={proto}");
}
