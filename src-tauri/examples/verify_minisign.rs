use minisign_verify::{PublicKey, Signature};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1).map(PathBuf::from);
    let public_key_path = args.next().ok_or("missing decoded public-key path")?;
    let payload_path = args.next().ok_or("missing signed payload path")?;
    let signature_path = args.next().ok_or("missing decoded signature path")?;
    if args.next().is_some() {
        return Err("unexpected extra arguments".into());
    }

    let public_key = PublicKey::from_file(public_key_path)?;
    let signature = Signature::from_file(signature_path)?;
    let payload = std::fs::read(payload_path)?;
    public_key.verify(&payload, &signature, false)?;

    println!("Updater signing keypair challenge verified.");
    Ok(())
}
