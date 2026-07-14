fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri normally puts this manifest inside its Windows resource. Link
        // the same manifest explicitly instead so Rust's lib test harness gets
        // Common Controls v6 too; otherwise TaskDialogIndirect is resolved from
        // legacy comctl32 before a single unit test can run.
        let manifest = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
        )
        .join("windows.common-controls.manifest");
        println!("cargo::rerun-if-changed={}", manifest.display());
        println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
            manifest.display()
        );
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}
