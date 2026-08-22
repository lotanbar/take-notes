use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::fs::{File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use tauri::Manager;

// Append-only single-file container. Layout:
//   [8 bytes file magic]
//   [record]*                  -- 'B' (blob) or 'H' (header) records, appended over time
//   [24 byte trailer]          -- always the last bytes of a well-formed file
//
// Each record: [1 byte tag]['8 bytes LE length']['length' bytes payload]
// Trailer:     [8 bytes LE header_offset][8 bytes LE format_version][8 byte trailer magic]
//
// A save never rewrites existing bytes: it truncates off only the trailing
// trailer (a fixed 24 bytes), appends new record(s), and appends a fresh
// trailer. Old blob/header records left behind by earlier saves become dead
// space, reclaimed only by an explicit compaction (Save As rewrites a fresh
// file with just the live blobs). This is what lets editing one note cost
// bytes proportional to that note, not the whole vault.
const FILE_MAGIC: &[u8; 8] = b"VNVLTV02";
const TRAILER_MAGIC: &[u8; 8] = b"VNTRLR02";
const TRAILER_LEN: u64 = 24;
const RECORD_PREFIX_LEN: u64 = 9; // 1 byte tag + 8 byte length
const FORMAT_VERSION: u64 = 2;

#[derive(Serialize)]
#[serde(tag = "format")]
pub enum VaultOpenResult {
    #[serde(rename = "v2")]
    V2 { header: String },
    #[serde(rename = "legacy")]
    Legacy { contents: String },
}

#[derive(Serialize)]
pub struct BlobLocation {
    #[serde(rename = "payloadOffset")]
    payload_offset: u64,
    length: u64,
    checksum: String,
}

fn read_trailer(file: &mut File, file_len: u64) -> Option<(u64, u64)> {
    if file_len < TRAILER_LEN {
        return None;
    }
    let mut buf = [0u8; TRAILER_LEN as usize];
    file.seek(SeekFrom::Start(file_len - TRAILER_LEN)).ok()?;
    file.read_exact(&mut buf).ok()?;
    if &buf[16..24] != TRAILER_MAGIC {
        return None;
    }
    let header_offset = u64::from_le_bytes(buf[0..8].try_into().ok()?);
    let version = u64::from_le_bytes(buf[8..16].try_into().ok()?);
    Some((header_offset, version))
}

// Where the next record should be appended: right after the last live byte,
// dropping only a trailing trailer if one is present.
fn compute_append_offset(file: &mut File) -> Result<u64, String> {
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    match read_trailer(file, file_len) {
        Some(_) => Ok(file_len - TRAILER_LEN),
        None => Ok(file_len),
    }
}

fn ensure_magic(file: &mut File) -> Result<(), String> {
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    if file_len == 0 {
        file.write_all(FILE_MAGIC).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut buf = [0u8; 8];
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    if &buf != FILE_MAGIC {
        return Err("not a v2 vault file".to_string());
    }
    Ok(())
}

fn open_rw(path: &str) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())
}

fn append_record(file: &mut File, tag: u8, payload: &[u8]) -> Result<u64, String> {
    let offset = compute_append_offset(file)?;
    file.set_len(offset).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut record = Vec::with_capacity(RECORD_PREFIX_LEN as usize + payload.len());
    record.push(tag);
    record.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    record.extend_from_slice(payload);
    file.write_all(&record).map_err(|e| e.to_string())?;
    Ok(offset)
}

fn write_trailer(file: &mut File, header_offset: u64, version: u64) -> Result<(), String> {
    file.write_all(&header_offset.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&version.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(TRAILER_MAGIC).map_err(|e| e.to_string())
}

/// Reads just the header (small: tree structure + metadata, no note bodies)
/// if this is a v2 container, or the whole file if it's the old flat-JSON
/// format (caller migrates in that case).
#[tauri::command]
pub fn open_vault_file(path: String) -> Result<VaultOpenResult, String> {
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();

    if file_len >= 8 {
        let mut magic = [0u8; 8];
        file.read_exact(&mut magic).map_err(|e| e.to_string())?;
        if &magic == FILE_MAGIC {
            let (header_offset, _version) = read_trailer(&mut file, file_len)
                .ok_or_else(|| "vault file is corrupt (missing trailer)".to_string())?;
            file.seek(SeekFrom::Start(header_offset))
                .map_err(|e| e.to_string())?;
            let mut prefix = [0u8; RECORD_PREFIX_LEN as usize];
            file.read_exact(&mut prefix).map_err(|e| e.to_string())?;
            if prefix[0] != b'H' {
                return Err("vault file is corrupt (bad header record)".to_string());
            }
            let payload_len = u64::from_le_bytes(
                prefix[1..9]
                    .try_into()
                    .map_err(|_| "corrupt length field".to_string())?,
            );
            let mut payload = vec![0u8; payload_len as usize];
            file.read_exact(&mut payload).map_err(|e| e.to_string())?;
            let header = String::from_utf8(payload).map_err(|e| e.to_string())?;
            return Ok(VaultOpenResult::V2 { header });
        }
    }

    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(VaultOpenResult::Legacy { contents })
}

/// Appends one opaque encrypted blob (a note's whole encrypted content) and
/// returns where to find it. Never touches any other bytes in the file.
#[tauri::command]
pub fn vault_append_blob(path: String, data_b64: String) -> Result<BlobLocation, String> {
    let mut file = open_rw(&path)?;
    ensure_magic(&mut file)?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    let prior_trailer = read_trailer(&mut file, file_len);
    let data = general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let offset = append_record(&mut file, b'B', &data)?;
    // Keep the previous header generation readable until a new header is
    // durably published. A crash between blob append and header write then
    // leaves only an unreachable blob, never a vault with a missing trailer.
    if let Some((header_offset, version)) = prior_trailer {
        write_trailer(&mut file, header_offset, version)?;
    }
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(BlobLocation {
        payload_offset: offset + RECORD_PREFIX_LEN,
        length: data.len() as u64,
        checksum: format!("{:x}", Sha256::digest(&data)),
    })
}

/// Appends the (small) header record plus a fresh trailer pointing at it.
/// This is the only thing that needs rewriting on a typical text edit.
#[tauri::command]
pub fn vault_write_header(path: String, header_json: String) -> Result<(), String> {
    let mut file = open_rw(&path)?;
    ensure_magic(&mut file)?;
    let payload = header_json.into_bytes();
    let header_offset = append_record(&mut file, b'H', &payload)?;

    write_trailer(&mut file, header_offset, FORMAT_VERSION)?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn read_vault_blob(
    path: String,
    payload_offset: u64,
    length: u64,
    checksum: Option<String>,
) -> Result<String, String> {
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    if payload_offset < RECORD_PREFIX_LEN
        || length > file_len
        || payload_offset > file_len.saturating_sub(length)
    {
        return Err("vault record is malformed (blob reference is out of bounds)".into());
    }
    file.seek(SeekFrom::Start(payload_offset - RECORD_PREFIX_LEN))
        .map_err(|e| e.to_string())?;
    let mut prefix = [0u8; RECORD_PREFIX_LEN as usize];
    file.read_exact(&mut prefix)
        .map_err(|_| "vault record is malformed (missing blob prefix)".to_string())?;
    let stored_length = u64::from_le_bytes(
        prefix[1..9]
            .try_into()
            .map_err(|_| "vault record is malformed (bad length)".to_string())?,
    );
    if prefix[0] != b'B' || stored_length != length {
        return Err("vault record is malformed (blob tag or length mismatch)".into());
    }
    file.seek(SeekFrom::Start(payload_offset))
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; length as usize];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    if let Some(expected) = checksum {
        let actual = format!("{:x}", Sha256::digest(&buf));
        if actual != expected.to_ascii_lowercase() {
            return Err("vault record checksum mismatch".into());
        }
    }
    Ok(general_purpose::STANDARD.encode(&buf))
}

/// Truncates/creates an empty file so a subsequent append starts clean —
/// used for brand-new vaults and Save-As targets, where any prior file at
/// that path (unrelated content, or a previous vault) must not be appended to.
#[tauri::command]
pub fn vault_create_fresh(path: String) -> Result<(), String> {
    File::create(&path).map_err(|e| e.to_string())?;
    Ok(())
}

// Backups live in the app's own data directory, named from the vault's stem
// plus a hash of its full path (so two vaults that happen to share a filename
// in different folders don't collide) — never dropped next to the vault
// itself, which just clutters whatever folder the user keeps their notes in.
#[tauri::command]
pub fn backup_vault_file(
    app: tauri::AppHandle,
    path: String,
    _suffix: String,
) -> Result<(), String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    dir.push("vault-backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stem = Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault".to_string());
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);

    dir.push(format!(
        "{stem}-{:016x}.last-known-good.vlt",
        hasher.finish()
    ));
    let temp = dir.with_extension("tmp");
    std::fs::copy(&path, &temp).map_err(|e| e.to_string())?;
    if dir.exists() {
        std::fs::remove_file(&dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, &dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn finalize_vault_write(temp_path: String, target_path: String) -> Result<(), String> {
    crate::atomic_file::replace(Path::new(&temp_path), Path::new(&target_path))
}

#[tauri::command]
pub fn vault_file_exists(path: String) -> bool {
    std::fs::metadata(&path).is_ok()
}

#[tauri::command]
pub fn vault_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(path)
        .map(|value| value.len())
        .map_err(|e| e.to_string())
}

// The local-only "live" copy each device keeps for a given cloud-facing vault
// path never lives inside the synced folder itself (see resolve_live_vault_path),
// so it needs its own deterministic location on this device. Copying between
// live and cloud paths always goes through this: write the full file to a temp
// path next to the destination, fsync it, then rename() over the destination.
// The rename is atomic on NTFS, so any sync engine watching `dest_path` only
// ever observes either the old complete file or the new complete file, never a
// partial one -- this is what actually fixes torn reads, not the destination
// being "just text".
#[tauri::command]
pub fn copy_file_atomic(source_path: String, dest_path: String) -> Result<(), String> {
    let tmp_path = format!("{dest_path}.xfer.tmp");
    std::fs::copy(&source_path, &tmp_path).map_err(|e| format!("copy to temp file failed: {e}"))?;
    {
        // FlushFileBuffers (what sync_all calls on Windows) needs a handle
        // opened for write, not just read — File::open alone fails here with
        // "Access is denied".
        let f = OpenOptions::new()
            .write(true)
            .open(&tmp_path)
            .map_err(|e| format!("reopening temp file for fsync failed: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("fsync of temp file failed: {e}"))?;
    }
    crate::atomic_file::replace(Path::new(&tmp_path), Path::new(&dest_path))
        .map_err(|e| format!("rename over destination failed: {e}"))?;
    Ok(())
}

fn file_hash(path: &str) -> Result<[u8; 32], String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

#[tauri::command]
pub fn copy_file_atomic_verified(source_path: String, dest_path: String) -> Result<(), String> {
    let source_hash = file_hash(&source_path)?;
    copy_file_atomic(source_path, dest_path.clone())?;
    if file_hash(&dest_path)? != source_hash {
        return Err("published vault checksum mismatch".into());
    }
    Ok(())
}

// Deterministic per-device location for a vault's "live" working copy, derived
// from the cloud-facing path the user actually opened (same stem+path-hash
// scheme as backup_vault_file, just a different directory) so the same vault
// always maps to the same local file on a given machine. Lives under the
// app's local (non-roamed) data dir -- never inside a folder any sync client
// watches -- so the frequent small in-place writes a text editor naturally
// makes never give a sync engine a half-written file to pick up.
#[tauri::command]
pub fn resolve_live_vault_path(app: tauri::AppHandle, sync_path: String) -> Result<String, String> {
    let mut dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    dir.push("live-vaults");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stem = Path::new(&sync_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault".to_string());
    let mut hasher = DefaultHasher::new();
    sync_path.hash(&mut hasher);

    dir.push(format!("{stem}-{:016x}.vlt", hasher.finish()));
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("vault-notes-test-{name}-{nanos}.vlt"));
        p.to_string_lossy().to_string()
    }

    fn b64(s: &str) -> String {
        general_purpose::STANDARD.encode(s.as_bytes())
    }

    fn unb64(s: &str) -> String {
        String::from_utf8(general_purpose::STANDARD.decode(s).unwrap()).unwrap()
    }

    #[test]
    fn fresh_vault_roundtrip() {
        let path = temp_path("fresh");
        vault_create_fresh(path.clone()).unwrap();

        let loc = vault_append_blob(path.clone(), b64("hello note content")).unwrap();
        vault_write_header(path.clone(), r#"{"tree":"stub"}"#.to_string()).unwrap();

        match open_vault_file(path.clone()).unwrap() {
            VaultOpenResult::V2 { header } => assert_eq!(header, r#"{"tree":"stub"}"#),
            VaultOpenResult::Legacy { .. } => panic!("expected v2"),
        }

        let blob_b64 = read_vault_blob(
            path.clone(),
            loc.payload_offset,
            loc.length,
            Some(loc.checksum),
        )
        .unwrap();
        assert_eq!(unb64(&blob_b64), "hello note content");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn later_saves_dont_disturb_earlier_blobs() {
        let path = temp_path("multi");
        vault_create_fresh(path.clone()).unwrap();

        let loc_a = vault_append_blob(path.clone(), b64("note A content")).unwrap();
        vault_write_header(path.clone(), r#"{"a":true}"#.to_string()).unwrap();

        // A second full save cycle (blob + header) must not corrupt or move
        // the first blob — this is the core "editing one note doesn't touch
        // another" guarantee.
        let loc_b = vault_append_blob(path.clone(), b64("note B content")).unwrap();
        vault_write_header(path.clone(), r#"{"a":true,"b":true}"#.to_string()).unwrap();

        // A third save that only touches note A's blob again (simulating a
        // text edit) must still leave B's already-written blob readable.
        let loc_a2 = vault_append_blob(path.clone(), b64("note A edited content")).unwrap();
        vault_write_header(path.clone(), r#"{"a":"edited","b":true}"#.to_string()).unwrap();

        match open_vault_file(path.clone()).unwrap() {
            VaultOpenResult::V2 { header } => assert_eq!(header, r#"{"a":"edited","b":true}"#),
            VaultOpenResult::Legacy { .. } => panic!("expected v2"),
        }

        assert_eq!(
            unb64(
                &read_vault_blob(
                    path.clone(),
                    loc_a.payload_offset,
                    loc_a.length,
                    Some(loc_a.checksum)
                )
                .unwrap()
            ),
            "note A content"
        );
        assert_eq!(
            unb64(
                &read_vault_blob(
                    path.clone(),
                    loc_b.payload_offset,
                    loc_b.length,
                    Some(loc_b.checksum)
                )
                .unwrap()
            ),
            "note B content"
        );
        assert_eq!(
            unb64(
                &read_vault_blob(
                    path.clone(),
                    loc_a2.payload_offset,
                    loc_a2.length,
                    Some(loc_a2.checksum)
                )
                .unwrap()
            ),
            "note A edited content"
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn blob_append_keeps_previous_generation_openable() {
        let path = temp_path("append-crash-window");
        vault_create_fresh(path.clone()).unwrap();
        vault_write_header(path.clone(), r#"{"generation":1}"#.to_string()).unwrap();
        vault_append_blob(path.clone(), b64("not referenced yet")).unwrap();
        match open_vault_file(path.clone()).unwrap() {
            VaultOpenResult::V2 { header } => assert_eq!(header, r#"{"generation":1}"#),
            VaultOpenResult::Legacy { .. } => panic!("expected v2"),
        }
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn blob_reads_reject_header_and_out_of_bounds_references() {
        let path = temp_path("blob-bounds");
        vault_create_fresh(path.clone()).unwrap();
        let loc = vault_append_blob(path.clone(), b64("valid")).unwrap();
        vault_write_header(path.clone(), r#"{"tree":{}}"#.to_string()).unwrap();
        assert!(read_vault_blob(path.clone(), loc.payload_offset, loc.length + 1, None).is_err());
        assert!(read_vault_blob(path.clone(), 1, 5, None).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn legacy_json_file_detected_and_returned_whole() {
        let path = temp_path("legacy");
        std::fs::write(&path, r#"{"version":1,"tree":{}}"#).unwrap();

        match open_vault_file(path.clone()).unwrap() {
            VaultOpenResult::Legacy { contents } => {
                assert_eq!(contents, r#"{"version":1,"tree":{}}"#)
            }
            VaultOpenResult::V2 { .. } => panic!("expected legacy"),
        }

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn corrupt_trailer_is_rejected_not_silently_accepted() {
        let path = temp_path("corrupt");
        let mut bytes = FILE_MAGIC.to_vec();
        bytes.extend_from_slice(b"garbage garbage garbage garbage garbage");
        std::fs::write(&path, &bytes).unwrap();

        let result = open_vault_file(path.clone());
        assert!(result.is_err());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn overwriting_fresh_target_does_not_append_to_old_content() {
        // Simulates "Save As" / vault-create landing on a path that already
        // has an unrelated v2 vault: vault_create_fresh must produce a clean
        // slate, not silently append onto what was there.
        let path = temp_path("overwrite");
        vault_create_fresh(path.clone()).unwrap();
        vault_append_blob(path.clone(), b64("old vault's note")).unwrap();
        vault_write_header(path.clone(), r#"{"old":true}"#.to_string()).unwrap();

        vault_create_fresh(path.clone()).unwrap();
        let loc = vault_append_blob(path.clone(), b64("new vault's note")).unwrap();
        vault_write_header(path.clone(), r#"{"new":true}"#.to_string()).unwrap();

        match open_vault_file(path.clone()).unwrap() {
            VaultOpenResult::V2 { header } => assert_eq!(header, r#"{"new":true}"#),
            VaultOpenResult::Legacy { .. } => panic!("expected v2"),
        }
        assert_eq!(
            unb64(
                &read_vault_blob(
                    path.clone(),
                    loc.payload_offset,
                    loc.length,
                    Some(loc.checksum)
                )
                .unwrap()
            ),
            "new vault's note"
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn vault_file_exists_reflects_reality() {
        let path = temp_path("exists");
        assert!(!vault_file_exists(path.clone()));
        std::fs::write(&path, b"anything").unwrap();
        assert!(vault_file_exists(path.clone()));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn copy_file_atomic_copies_content_and_leaves_source_untouched() {
        let source = temp_path("copy-src");
        let dest = temp_path("copy-dest");
        std::fs::write(&source, b"live vault bytes").unwrap();

        copy_file_atomic(source.clone(), dest.clone()).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"live vault bytes");
        assert_eq!(std::fs::read(&source).unwrap(), b"live vault bytes");
        // No leftover temp file from the copy-then-rename.
        assert!(!Path::new(&format!("{dest}.xfer.tmp")).exists());

        std::fs::remove_file(&source).ok();
        std::fs::remove_file(&dest).ok();
    }

    #[test]
    fn copy_file_atomic_overwrites_existing_destination() {
        let source = temp_path("copy-src2");
        let dest = temp_path("copy-dest2");
        std::fs::write(&source, b"new content").unwrap();
        std::fs::write(&dest, b"stale destination content that is longer").unwrap();

        copy_file_atomic(source.clone(), dest.clone()).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"new content");

        std::fs::remove_file(&source).ok();
        std::fs::remove_file(&dest).ok();
    }

    #[test]
    fn verified_copy_matches_source_bytes() {
        let source = temp_path("verified-copy-source");
        let destination = temp_path("verified-copy-destination");
        std::fs::write(&source, b"verified vault bytes").unwrap();
        std::fs::write(&destination, b"old bytes that must be replaced").unwrap();
        copy_file_atomic_verified(source.clone(), destination.clone()).unwrap();
        assert_eq!(
            file_hash(&source).unwrap(),
            file_hash(&destination).unwrap()
        );
        std::fs::remove_file(source).ok();
        std::fs::remove_file(destination).ok();
    }
}
