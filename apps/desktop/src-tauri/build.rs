fn main() {
    // include_dir tracks existing files, but newly added assets need a rebuild too.
    println!("cargo:rerun-if-changed=../../../packages/ui/public");
    tauri_build::build()
}
