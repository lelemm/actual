fn main() {
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
