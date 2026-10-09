fn main() {
    println!("cargo:rerun-if-env-changed=ECHO_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=ECHO_RELEASE_QUALIFIED");
    let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let shared = root.join("ui/shared");
    std::fs::create_dir_all(shared.join("fonts")).expect("Create shared launcher assets");
    for name in [
        "design-tokens.css",
        "favicon.svg",
        "fonts/inter.css",
        "fonts/inter-400.woff2",
        "fonts/inter-500.woff2",
        "fonts/inter-600.woff2",
    ] {
        let source = root.join("../public").join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        if name == "fonts/inter.css" {
            let css = std::fs::read_to_string(&source)
                .expect("Read shared font definitions")
                .replace("url('/fonts/", "url('/shared/fonts/");
            std::fs::write(shared.join(name), css).expect("Write shared font definitions");
        } else {
            std::fs::copy(source, shared.join(name)).expect("Copy shared launcher asset");
        }
    }
    tauri_build::build()
}
