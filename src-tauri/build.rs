fn main() {
    // On iOS, the cdylib link step encounters undefined symbols for the
    // C-ABI functions defined in NowPlaying.swift (which only resolve at
    // Xcode's final link step). Allow them to remain undefined here and let
    // Xcode resolve them later when it links the Swift object files in.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }

    tauri_build::build()
}
