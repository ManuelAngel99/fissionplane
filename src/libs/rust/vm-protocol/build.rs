//! Compile the wire schema. protoc is vendored so developers need nothing
//! installed beyond the Rust toolchain.

// A build script that cannot compile the schema must fail loudly; that is
// the entire point of the script.
#![allow(clippy::expect_used)]

fn main() {
    // Hand prost-build the vendored protoc directly rather than through
    // the PROTOC environment variable: `std::env::set_var` is an unsafe
    // fn in edition 2024, and the workspace denies unsafe code.
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("locate vendored protoc");
    prost_build::Config::new()
        .protoc_executable(protoc)
        .compile_protos(&["proto/vm.proto"], &["proto/"])
        .expect("compile vm.proto");
    println!("cargo:rerun-if-changed=proto/vm.proto");
}
