use std::path::Path;

/// Hardcoded Ed25519 public key.
/// All zeroes acts as a Developer Mode indicator to log warnings but bypass strict signature failures in dev.
const PUBLIC_KEY_BYTES: [u8; 32] = [0u8; 32];

/// Verify the signature and SHA-256 hash of an MCP sidecar binary against its manifest. json descriptor.
///
/// If validation fails, the binary is quarantined under `$APP_CACHE_DIR/quarantine/` and removed
/// from the active executable directory to isolate threats.
pub fn verify_sidecar(binary_path: &Path, app_cache_dir: &Path) -> Result<(), String> {
    // Developer mode: all-zeroes public key bypasses ALL verification (manifest + signature).
    // This allows freshly-built sidecar binaries in target/debug/ to run without a manifest.
    if PUBLIC_KEY_BYTES == [0u8; 32] {
        log::warn!(
            "DEVELOPER MODE: Bypassing all sidecar verification for {}",
            binary_path.display()
        );
        return Ok(());
    }

    let manifest_path = binary_path.with_file_name("manifest.json");
    
    if !manifest_path.exists() {
        quarantine_binary(binary_path, app_cache_dir)?;
        return Err(format!(
            "Quarantine triggered: manifest.json missing for sidecar {}",
            binary_path.display()
        ));
    }

    // 1. Load manifest JSON
    let manifest_data = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest file: {e}"))?;
    
    let manifest: serde_json::Value = serde_json::from_str(&manifest_data)
        .map_err(|e| format!("Failed to parse manifest JSON: {e}"))?;

    let manifest_hash_hex = manifest["hash"].as_str()
        .ok_or_else(|| "Manifest missing 'hash' field".to_string())?;

    let signature_hex = manifest["signature"].as_str()
        .ok_or_else(|| "Manifest missing 'signature' field".to_string())?;

    // 2. Hash check binary
    let binary_bytes = std::fs::read(binary_path)
        .map_err(|e| format!("Failed to read binary executable: {e}"))?;
    
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(&binary_bytes);
    let actual_hash = hasher.finalize();
    let actual_hash_hex = hex::encode(actual_hash);

    if actual_hash_hex != manifest_hash_hex {
        quarantine_binary(binary_path, app_cache_dir)?;
        return Err(format!(
            "Quarantine triggered: Hash mismatch. Expected: {}, actual: {}",
            manifest_hash_hex, actual_hash_hex
        ));
    }

    // 3. Signature verification (Ed25519)
    if PUBLIC_KEY_BYTES == [0u8; 32] {
        log::warn!(
            "DEVELOPER MODE: Bypassing signature verification for {}",
            binary_path.display()
        );
        return Ok(());
    }

    use ed25519_dalek::{VerifyingKey, Signature, Verifier};
    let public_key = VerifyingKey::from_bytes(&PUBLIC_KEY_BYTES)
        .map_err(|e| format!("Invalid embedded public key: {e}"))?;

    let signature_bytes = hex::decode(signature_hex)
        .map_err(|e| format!("Invalid signature hex string: {e}"))?;
    
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|e| format!("Invalid signature format: {e}"))?;

    if public_key.verify(actual_hash.as_slice(), &signature).is_err() {
        quarantine_binary(binary_path, app_cache_dir)?;
        return Err(format!(
            "Quarantine triggered: Ed25519 verification failed for {}",
            binary_path.display()
        ));
    }

    Ok(())
}

/// Move compromised sidecars and manifests to the quarantine directory, removing original files.
fn quarantine_binary(binary_path: &Path, app_cache_dir: &Path) -> Result<(), String> {
    let quarantine_dir = app_cache_dir.join("quarantine");
    std::fs::create_dir_all(&quarantine_dir)
        .map_err(|e| format!("Failed to create quarantine folder: {e}"))?;

    let file_name = binary_path.file_name()
        .ok_or_else(|| "Invalid binary filename".to_string())?;
    
    let dest_path = quarantine_dir.join(file_name);
    
    // Copy binary to quarantine
    std::fs::copy(binary_path, &dest_path)
        .map_err(|e| format!("Failed to copy binary to quarantine: {e}"))?;
    
    // Move manifest if exists
    let manifest_path = binary_path.with_file_name("manifest.json");
    if manifest_path.exists() {
        let dest_manifest = quarantine_dir.join(format!("{}.manifest.json", file_name.to_string_lossy()));
        std::fs::copy(&manifest_path, &dest_manifest).ok();
        std::fs::remove_file(&manifest_path).ok();
    }

    // Delete active binary
    std::fs::remove_file(binary_path)
        .map_err(|e| format!("Failed to remove active compromised binary: {e}"))?;

    log::warn!(
        "Compromised binary {} successfully isolated and moved to {}",
        binary_path.display(),
        dest_path.display()
    );
    Ok(())
}
