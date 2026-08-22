use fs2::FileExt;
use git2::{IndexAddOption, Oid, Repository, Signature, Time};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SOURCE_FILE: &str = "SOURCE_PATH.txt";
const REVISION_FILE: &str = "revision.json";
const RECOVERY_FILE: &str = "RECOVERY.md";
const FILE_MAGIC: &[u8; 8] = b"VNVLTV02";
const TRAILER_MAGIC: &[u8; 8] = b"VNTRLR02";
static HISTORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct HistoryGuard {
    _process: MutexGuard<'static, ()>,
    file: File,
}
impl Drop for HistoryGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    status: String,
    repository_path: String,
    detail: Option<String>,
    commit_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    repository_path: String,
    imported_revisions: usize,
    deleted_paths: Vec<String>,
    reclaimed_bytes: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct RecordRef {
    tag: u8,
    hash: String,
    length: u64,
}

#[derive(Deserialize, Serialize)]
struct Revision {
    format_version: u64,
    records: Vec<RecordRef>,
    source_vault_hash: String,
    original_commit_id: Option<String>,
}

fn normalized_source(path: &str) -> String {
    let absolute = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let value = absolute.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}
fn safe_name(source_path: &str) -> String {
    let stem = Path::new(source_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let hash = format!(
        "{:x}",
        Sha256::digest(normalized_source(source_path).as_bytes())
    );
    format!(
        "{}-{}",
        if safe.is_empty() { "vault" } else { &safe },
        &hash[..12]
    )
}
fn repo_path(app: &tauri::AppHandle, source: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("vault-recovery")
        .join(safe_name(source)))
}
fn old_paths(app: &tauri::AppHandle, source: &str) -> Result<Vec<PathBuf>, String> {
    let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let roaming = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for root in [
        local.join("vault-history"),
        roaming.join("secondary-history").join("vault-history"),
    ] {
        if root.exists() {
            for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                let recorded = fs::read_to_string(path.join(SOURCE_FILE)).unwrap_or_default();
                if normalized_source(recorded.trim()) == normalized_source(source) {
                    result.push(path);
                }
            }
        }
    }
    Ok(result)
}

fn lock(app: &tauri::AppHandle, source: &str) -> Result<(PathBuf, HistoryGuard), String> {
    let process = HISTORY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "history lock poisoned")?;
    let path = repo_path(app, source)?;
    let parent = path.parent().ok_or("history path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(parent.join(format!(".{}.lock", safe_name(source))))
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok((
        path,
        HistoryGuard {
            _process: process,
            file,
        },
    ))
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

type VaultObjects = Vec<(String, Vec<u8>)>;

fn parse_vault(
    bytes: &[u8],
    original_commit_id: Option<String>,
) -> Result<(Revision, VaultObjects), String> {
    if bytes.len() < 32 || &bytes[..8] != FILE_MAGIC || &bytes[bytes.len() - 8..] != TRAILER_MAGIC {
        return Err("vault is not a valid object container".into());
    }
    let trailer = bytes.len() - 24;
    let format_version = u64::from_le_bytes(
        bytes[trailer + 8..trailer + 16]
            .try_into()
            .map_err(|_| "bad trailer")?,
    );
    let mut offset = 8usize;
    let mut records = Vec::new();
    let mut objects = Vec::new();
    while offset < trailer {
        if offset + 9 > trailer {
            return Err("truncated vault record".into());
        }
        let tag = bytes[offset];
        let length = u64::from_le_bytes(
            bytes[offset + 1..offset + 9]
                .try_into()
                .map_err(|_| "bad record length")?,
        ) as usize;
        let end = offset + 9 + length;
        if end > trailer || (tag != b'B' && tag != b'H') {
            return Err("invalid vault record".into());
        }
        let payload = bytes[offset + 9..end].to_vec();
        let digest = hash(&payload);
        records.push(RecordRef {
            tag,
            hash: digest.clone(),
            length: length as u64,
        });
        objects.push((digest, payload));
        offset = end;
    }
    if records.last().map(|r| r.tag) != Some(b'H') {
        return Err("vault has no final manifest record".into());
    }
    Ok((
        Revision {
            format_version,
            records,
            source_vault_hash: hash(bytes),
            original_commit_id,
        },
        objects,
    ))
}

fn write_snapshot(repo_path: &Path, bytes: &[u8], original: Option<String>) -> Result<(), String> {
    let (revision, objects) = parse_vault(bytes, original)?;
    let objects_dir = repo_path.join("objects");
    fs::create_dir_all(&objects_dir).map_err(|e| e.to_string())?;
    for (digest, data) in objects {
        let target = objects_dir.join(&digest);
        if !target.exists() {
            let tmp = objects_dir.join(format!("{digest}.tmp"));
            fs::write(&tmp, data).map_err(|e| e.to_string())?;
            fs::rename(tmp, target).map_err(|e| e.to_string())?;
        }
    }
    fs::write(
        repo_path.join(REVISION_FILE),
        serde_json::to_vec_pretty(&revision).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn commit(repo: &Repository, message: &str, timestamp: i64) -> Result<bool, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if parent.as_ref().is_some_and(|p| p.tree_id() == tree_id) {
        return Ok(false);
    }
    let sig = Signature::new(
        "Vault Notes",
        "local-history@vault-notes.invalid",
        &Time::new(timestamp, 0),
    )
    .map_err(|e| e.to_string())?;
    let parents: Vec<_> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(true)
}
fn init_repo(path: &Path, source: &str) -> Result<Repository, String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let repo = Repository::init(path).map_err(|e| e.to_string())?;
    fs::write(
        path.join(SOURCE_FILE),
        format!("{}\n", normalized_source(source)),
    )
    .map_err(|e| e.to_string())?;
    fs::write(path.join(RECOVERY_FILE), "# Vault recovery\n\nEach commit references a complete encrypted revision through revision.json and content-addressed objects. Use the app's restore command.\n").map_err(|e| e.to_string())?;
    Ok(repo)
}

fn count(repo: &Repository) -> usize {
    repo.revwalk()
        .map(|mut w| {
            let _ = w.push_head();
            w.count()
        })
        .unwrap_or(0)
}
fn inspect(path: &Path, source: &str) -> HistoryStatus {
    let result = (|| -> Result<usize, String> {
        let repo = Repository::open(path).map_err(|e| e.to_string())?;
        let recorded = fs::read_to_string(path.join(SOURCE_FILE)).map_err(|e| e.to_string())?;
        if normalized_source(recorded.trim()) != normalized_source(source) {
            return Err("recovery repository belongs to a different vault".into());
        }
        let head = repo
            .head()
            .and_then(|value| value.peel_to_commit())
            .map_err(|e| e.to_string())?;
        reconstruct(&repo, &head)?;
        Ok(count(&repo))
    })();
    match result {
        Ok(n) => HistoryStatus {
            status: "ready".into(),
            repository_path: path.to_string_lossy().into(),
            detail: None,
            commit_count: n,
        },
        Err(_e) if !path.exists() => HistoryStatus {
            status: "missing".into(),
            repository_path: path.to_string_lossy().into(),
            detail: None,
            commit_count: 0,
        },
        Err(e) => HistoryStatus {
            status: "corrupt".into(),
            repository_path: path.to_string_lossy().into(),
            detail: Some(e),
            commit_count: 0,
        },
    }
}

fn reconstruct(repo: &Repository, commit: &git2::Commit<'_>) -> Result<Vec<u8>, String> {
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let revision_entry = tree
        .get_path(Path::new(REVISION_FILE))
        .map_err(|e| e.to_string())?;
    let revision_blob = repo
        .find_blob(revision_entry.id())
        .map_err(|e| e.to_string())?;
    let revision: Revision =
        serde_json::from_slice(revision_blob.content()).map_err(|e| e.to_string())?;
    let mut out = FILE_MAGIC.to_vec();
    let mut header_offset = 0u64;
    for record in revision.records {
        let object_path = Path::new("objects").join(&record.hash);
        let entry = tree.get_path(&object_path).map_err(|e| e.to_string())?;
        let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
        if blob.content().len() as u64 != record.length || hash(blob.content()) != record.hash {
            return Err("history object hash mismatch".into());
        }
        if record.tag == b'H' {
            header_offset = out.len() as u64;
        }
        out.push(record.tag);
        out.extend_from_slice(&record.length.to_le_bytes());
        out.extend_from_slice(blob.content());
    }
    out.extend_from_slice(&header_offset.to_le_bytes());
    out.extend_from_slice(&revision.format_version.to_le_bytes());
    out.extend_from_slice(TRAILER_MAGIC);
    if hash(&out) != revision.source_vault_hash {
        return Err("reconstructed vault checksum mismatch".into());
    }
    Ok(out)
}
fn verify_repo(repo: &Repository) -> Result<(), String> {
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.push_head().map_err(|e| e.to_string())?;
    let mut found = false;
    for oid in walk {
        found = true;
        let commit = repo
            .find_commit(oid.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        reconstruct(repo, &commit)?;
    }
    if !found {
        return Err("repository has no commits".into());
    }
    Ok(())
}

fn old_revisions(paths: &[PathBuf]) -> Vec<(i64, String, String, Vec<u8>)> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let Ok(repo) = Repository::open(path) else {
            continue;
        };
        let Ok(mut walk) = repo.revwalk() else {
            continue;
        };
        if walk.push_head().is_err() {
            continue;
        }
        for oid in walk.flatten() {
            let Ok(commit) = repo.find_commit(oid) else {
                continue;
            };
            let Ok(tree) = commit.tree() else { continue };
            let Ok(entry) = tree.get_path(Path::new("vault.vlt")) else {
                continue;
            };
            let Ok(blob) = repo.find_blob(entry.id()) else {
                continue;
            };
            let digest = hash(blob.content());
            if seen.insert(digest) {
                result.push((
                    commit.time().seconds(),
                    commit
                        .message()
                        .unwrap_or("Imported recovery revision")
                        .to_string(),
                    oid.to_string(),
                    blob.content().to_vec(),
                ));
            }
        }
    }
    result.sort_by_key(|r| r.0);
    result
}
fn dir_size(path: &Path) -> u64 {
    if path.is_file() {
        return path.metadata().map(|m| m.len()).unwrap_or(0);
    }
    fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| dir_size(&e.path())).sum())
        .unwrap_or(0)
}

fn migrate_locked(
    app: &tauri::AppHandle,
    source: &str,
    vault_path: &str,
    destination: &Path,
) -> Result<MigrationReport, String> {
    let old = old_paths(app, source)?;
    let revisions = old_revisions(&old);
    let temp = destination.with_extension("migrating");
    if temp.exists() {
        fs::remove_dir_all(&temp).map_err(|e| e.to_string())?;
    }
    let repo = init_repo(&temp, source)?;
    let mut imported = 0;
    for (timestamp, message, oid, bytes) in revisions {
        write_snapshot(&temp, &bytes, Some(oid.clone()))?;
        if commit(
            &repo,
            &format!("{message}\n\nOriginal-Commit-ID: {oid}"),
            timestamp,
        )? {
            imported += 1;
        }
    }
    let current = fs::read(vault_path).map_err(|e| e.to_string())?;
    write_snapshot(&temp, &current, None)?;
    if commit(&repo, "Current vault at history migration", now())? {
        imported += 1;
    }
    verify_repo(&repo)?;
    drop(repo);
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp, destination).map_err(|e| e.to_string())?;
    let mut reclaimed = 0;
    let mut deleted = Vec::new();
    for path in old {
        reclaimed += dir_size(&path);
        fs::remove_dir_all(&path).map_err(|e| {
            format!(
                "verified migration succeeded but deleting {} failed: {e}",
                path.display()
            )
        })?;
        deleted.push(path.to_string_lossy().into());
    }
    Ok(MigrationReport {
        repository_path: destination.to_string_lossy().into(),
        imported_revisions: imported,
        deleted_paths: deleted,
        reclaimed_bytes: reclaimed,
    })
}

#[tauri::command]
pub async fn history_status(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<HistoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _guard) = lock(&app, &source_path)?;
        Ok(inspect(&path, &source_path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn history_initialize(
    app: tauri::AppHandle,
    source_path: String,
    vault_path: String,
) -> Result<HistoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _guard) = lock(&app, &source_path)?;
        if inspect(&path, &source_path).status != "ready" {
            migrate_locked(&app, &source_path, &vault_path, &path)?;
        }
        Ok(inspect(&path, &source_path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn history_checkpoint(
    app: tauri::AppHandle,
    source_path: String,
    vault_path: String,
    reason: Option<String>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _guard) = lock(&app, &source_path)?;
        if inspect(&path, &source_path).status != "ready" {
            return Err("recovery history is not ready".into());
        }
        let bytes = fs::read(vault_path).map_err(|e| e.to_string())?;
        write_snapshot(&path, &bytes, None)?;
        let repo = Repository::open(path).map_err(|e| e.to_string())?;
        commit(
            &repo,
            reason.as_deref().unwrap_or("Vault checkpoint"),
            now(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn history_verify_integrity(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<HistoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _guard) = lock(&app, &source_path)?;
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        verify_repo(&repo)?;
        Ok(inspect(&path, &source_path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn history_restore(
    app: tauri::AppHandle,
    source_path: String,
    commit_id: String,
    destination_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _guard) = lock(&app, &source_path)?;
        let repo = Repository::open(path).map_err(|e| e.to_string())?;
        let oid = Oid::from_str(&commit_id).map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let bytes = reconstruct(&repo, &commit)?;
        let temp = format!("{destination_path}.restore.tmp");
        let mut file = File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        crate::atomic_file::replace(Path::new(&temp), Path::new(&destination_path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn history_migrate(
    app: tauri::AppHandle,
    source_path: String,
    vault_path: String,
) -> Result<MigrationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _guard) = lock(&app, &source_path)?;
        migrate_locked(&app, &source_path, &vault_path, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn history_maintenance(app: tauri::AppHandle, source_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _guard) = lock(&app, &source_path)?;
        let repo = Repository::open(path).map_err(|e| e.to_string())?;
        let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
        walk.push_head().map_err(|e| e.to_string())?;
        let mut pack = repo.packbuilder().map_err(|e| e.to_string())?;
        pack.insert_walk(&mut walk).map_err(|e| e.to_string())?;
        pack.write(&repo.path().join("objects").join("pack"), 0o600)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn container(blobs: &[&[u8]], header: &[u8]) -> Vec<u8> {
        let mut bytes = FILE_MAGIC.to_vec();
        for payload in blobs {
            bytes.push(b'B');
            bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
            bytes.extend_from_slice(payload);
        }
        let header_offset = bytes.len() as u64;
        bytes.push(b'H');
        bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
        bytes.extend_from_slice(header);
        bytes.extend_from_slice(&header_offset.to_le_bytes());
        bytes.extend_from_slice(&2u64.to_le_bytes());
        bytes.extend_from_slice(TRAILER_MAGIC);
        bytes
    }
    #[test]
    fn parses_and_rejects_corruption() {
        let mut bytes = FILE_MAGIC.to_vec();
        let payload = b"{}";
        bytes.push(b'H');
        bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        bytes.extend_from_slice(payload);
        let header = 8u64;
        bytes.extend_from_slice(&header.to_le_bytes());
        bytes.extend_from_slice(&2u64.to_le_bytes());
        bytes.extend_from_slice(TRAILER_MAGIC);
        assert!(parse_vault(&bytes, None).is_ok());
        bytes[8] = b'X';
        assert!(parse_vault(&bytes, None).is_err());
    }

    #[test]
    fn unchanged_objects_are_reused_between_complete_revisions() {
        let root = std::env::temp_dir().join(format!("vault-history-objects-{}", now()));
        let repo = init_repo(&root, "C:\\notes.vlt").unwrap();
        let first = container(&[b"note one", b"same media"], br#"{"generation":1}"#);
        write_snapshot(&root, &first, None).unwrap();
        commit(&repo, "one", 1).unwrap();
        let first_count = fs::read_dir(root.join("objects")).unwrap().count();
        let second = container(&[b"note two", b"same media"], br#"{"generation":2}"#);
        write_snapshot(&root, &second, None).unwrap();
        commit(&repo, "two", 2).unwrap();
        let second_count = fs::read_dir(root.join("objects")).unwrap().count();
        assert_eq!(
            second_count - first_count,
            2,
            "only the changed note and manifest should be new"
        );
        let restored = reconstruct(&repo, &repo.head().unwrap().peel_to_commit().unwrap()).unwrap();
        assert_eq!(restored, second);
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
}
