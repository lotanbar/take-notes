use git2::{IndexAddOption, Repository, Signature, Time};
use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SOURCE_FILE: &str = "SOURCE_PATH.txt";
const VAULT_FILE: &str = "vault.vlt";
const RECOVERY_FILE: &str = "RECOVERY.md";

static HISTORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

// The Mutex serializes work inside one app process. The file lock covers a
// second app instance (including a release build and `tauri dev`) using the
// same vault at the same time.
struct HistoryGuard {
    _process_guard: MutexGuard<'static, ()>,
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
    mirror_repository_path: String,
    detail: Option<String>,
}

struct RepoCheck {
    status: String,
    detail: Option<String>,
}

fn normalized_source(path: &str) -> String {
    let absolute = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let value = absolute.to_string_lossy().replace('/', "\\");
    if cfg!(windows) { value.to_lowercase() } else { value }
}

fn history_dir(base: &Path, source_path: &str) -> PathBuf {
    let stem = Path::new(source_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault".into());
    let safe_stem: String = stem.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let hash = format!("{:x}", Sha256::digest(normalized_source(source_path).as_bytes()));
    base.join("vault-history").join(format!("{}-{}", safe_stem, &hash[..12]))
}

fn app_history_dirs(app: &tauri::AppHandle, source_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let roaming = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok((history_dir(&local, source_path), history_dir(&roaming.join("secondary-history"), source_path)))
}

fn lock_history(app: &tauri::AppHandle, source_path: &str) -> Result<(PathBuf, PathBuf, HistoryGuard), String> {
    let process_guard = HISTORY_LOCK.get_or_init(|| Mutex::new(())).lock()
        .map_err(|_| "history lock poisoned".to_string())?;
    let (primary, mirror) = app_history_dirs(app, source_path)?;
    let parent = primary.parent().ok_or_else(|| "history has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("creating history lock directory failed: {e}"))?;
    make_private(parent)?;
    let lock_name = format!(".{}.lock", primary.file_name().unwrap_or_default().to_string_lossy());
    let file = OpenOptions::new().create(true).read(true).write(true).open(parent.join(lock_name))
        .map_err(|e| format!("opening history lock failed: {e}"))?;
    file.lock_exclusive().map_err(|e| format!("locking recovery history failed: {e}"))?;
    Ok((primary, mirror, HistoryGuard { _process_guard: process_guard, file }))
}

fn inspect(repo_path: &Path, source_path: &str) -> RepoCheck {
    if !repo_path.exists() {
        return RepoCheck { status: "missing".into(), detail: None };
    }
    let repo = match Repository::open(repo_path) {
        Ok(repo) => repo,
        Err(e) => return RepoCheck { status: "corrupt".into(), detail: Some(e.to_string()) },
    };
    let recorded = match fs::read_to_string(repo_path.join(SOURCE_FILE)) {
        Ok(value) => value.trim().to_string(),
        Err(e) => return RepoCheck { status: "corrupt".into(), detail: Some(e.to_string()) },
    };
    if normalized_source(&recorded) != normalized_source(source_path) {
        return RepoCheck { status: "path_mismatch".into(), detail: Some(recorded) };
    }
    let valid = repo.head().and_then(|h| h.peel_to_commit()).and_then(|c| c.tree()).is_ok()
        && repo_path.join(VAULT_FILE).is_file()
        && repo_path.join(RECOVERY_FILE).is_file();
    if !valid {
        return RepoCheck { status: "corrupt".into(), detail: Some("repository has no valid HEAD or required files".into()) };
    }
    RepoCheck { status: "ready".into(), detail: None }
}

fn inspect_pair(primary: &Path, mirror: &Path, source_path: &str) -> HistoryStatus {
    let primary_check = inspect(primary, source_path);
    if primary_check.status != "ready" {
        return HistoryStatus { status: primary_check.status, repository_path: primary.to_string_lossy().into(), mirror_repository_path: mirror.to_string_lossy().into(), detail: primary_check.detail };
    }
    let mirror_check = inspect(mirror, source_path);
    if mirror_check.status != "ready" {
        return HistoryStatus { status: mirror_check.status, repository_path: primary.to_string_lossy().into(), mirror_repository_path: mirror.to_string_lossy().into(), detail: mirror_check.detail.map(|d| format!("secondary history: {d}")) };
    }
    let primary_head = Repository::open(primary).and_then(|r| r.refname_to_id("HEAD")).ok();
    let mirror_head = Repository::open(mirror).and_then(|r| r.refname_to_id("HEAD")).ok();
    if primary_head.is_none() || primary_head != mirror_head {
        return HistoryStatus { status: "corrupt".into(), repository_path: primary.to_string_lossy().into(), mirror_repository_path: mirror.to_string_lossy().into(), detail: Some("the two recovery histories are out of sync".into()) };
    }
    HistoryStatus { status: "ready".into(), repository_path: primary.to_string_lossy().into(), mirror_repository_path: mirror.to_string_lossy().into(), detail: None }
}

// A crash can occur after one repository advances HEAD but before the other
// does. If one HEAD is a strict descendant of the other, there is no fork and
// the ahead repository is an unambiguous source from which to rebuild the
// lagging mirror. Unrelated/divergent histories are never auto-repaired.
fn reconcile_pair(primary: &Path, mirror: &Path, source_path: &str) -> Result<HistoryStatus, String> {
    let status = inspect_pair(primary, mirror, source_path);
    if status.status != "corrupt" || status.detail.as_deref() != Some("the two recovery histories are out of sync") {
        return Ok(status);
    }
    let primary_repo = Repository::open(primary).map_err(|e| e.to_string())?;
    let mirror_repo = Repository::open(mirror).map_err(|e| e.to_string())?;
    let primary_head = primary_repo.refname_to_id("HEAD").map_err(|e| e.to_string())?;
    let mirror_head = mirror_repo.refname_to_id("HEAD").map_err(|e| e.to_string())?;

    if primary_repo.graph_descendant_of(primary_head, mirror_head).unwrap_or(false) {
        drop(primary_repo);
        drop(mirror_repo);
        seed_mirror(primary, mirror)?;
    } else if mirror_repo.graph_descendant_of(mirror_head, primary_head).unwrap_or(false) {
        drop(primary_repo);
        drop(mirror_repo);
        seed_mirror(mirror, primary)?;
    } else {
        return Ok(status);
    }
    Ok(inspect_pair(primary, mirror, source_path))
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let temp = destination.with_extension("vlt.tmp");
    fs::copy(source, &temp).map_err(|e| format!("copying vault into history failed: {e}"))?;
    fs::rename(&temp, destination).map_err(|e| format!("publishing history snapshot failed: {e}"))
}

fn commit(repo: &Repository, message: &str, timestamp: i64) -> Result<bool, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if parent.as_ref().map(|p| p.tree_id() == tree_id).unwrap_or(false) {
        return Ok(false);
    }
    let signature = Signature::new("Vault Notes", "local-history@vault-notes.invalid", &Time::new(timestamp, 0)).map_err(|e| e.to_string())?;
    let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
    repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents).map_err(|e| e.to_string())?;
    maybe_pack(repo);
    Ok(true)
}

// Packing is maintenance only: a failure must never invalidate an otherwise
// durable checkpoint. Loose objects remain valid and a later interval retries.
fn maybe_pack(repo: &Repository) {
    let count = repo.revwalk().and_then(|mut walk| {
        walk.push_head()?;
        Ok(walk.count())
    }).unwrap_or(0);
    if count == 0 || count % 50 != 0 { return; }
    let result = (|| -> Result<(), git2::Error> {
        let mut walk = repo.revwalk()?;
        walk.push_head()?;
        let mut builder = repo.packbuilder()?;
        builder.insert_walk(&mut walk)?;
        builder.write(&repo.path().join("objects").join("pack"), 0o600)
    })();
    let _ = result;
}

fn preserve_invalid(path: &Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    for suffix in 0..1000u16 {
        let preserved = path.with_file_name(format!("{name}.preserved-{stamp}-{suffix}"));
        if preserved.exists() { continue; }
        return fs::rename(path, preserved).map_err(|e| format!("preserving invalid history failed: {e}"));
    }
    Err("preserving invalid history failed: could not allocate a unique destination".into())
}

fn unix_timestamp() -> Result<i64, String> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs() as i64)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = destination.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn seed_mirror(primary: &Path, mirror: &Path) -> Result<(), String> {
    preserve_invalid(mirror)?;
    let parent = mirror.parent().ok_or_else(|| "secondary history has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    make_private(parent)?;
    let temporary = mirror.with_file_name(format!("{}.seeding", mirror.file_name().unwrap_or_default().to_string_lossy()));
    if temporary.exists() { preserve_invalid(&temporary)?; }
    copy_tree(primary, &temporary)?;
    make_private(&temporary)?;
    fs::rename(&temporary, mirror).map_err(|e| format!("publishing secondary history failed: {e}"))
}

#[cfg(unix)]
fn make_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn make_private(_path: &Path) -> Result<(), String> { Ok(()) }

#[tauri::command]
pub async fn history_status(app: tauri::AppHandle, source_path: String) -> Result<HistoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (primary, mirror, _guard) = lock_history(&app, &source_path)?;
        reconcile_pair(&primary, &mirror, &source_path)
    })
    .await
    .map_err(|e| format!("history worker failed: {e}"))?
}

#[tauri::command]
pub async fn history_initialize(app: tauri::AppHandle, source_path: String, vault_path: String) -> Result<HistoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || history_initialize_blocking(app, source_path, vault_path))
        .await
        .map_err(|e| format!("history worker failed: {e}"))?
}

fn history_initialize_blocking(app: tauri::AppHandle, source_path: String, vault_path: String) -> Result<HistoryStatus, String> {
    let (primary, mirror, _guard) = lock_history(&app, &source_path)?;
    let existing = reconcile_pair(&primary, &mirror, &source_path)?;
    if existing.status == "ready" {
        return Ok(existing);
    }
    if inspect(&primary, &source_path).status == "ready" && inspect(&mirror, &source_path).status == "ready" {
        return Err(existing.detail.unwrap_or_else(|| "recovery histories have diverged".into()));
    }
    if inspect(&primary, &source_path).status != "ready" {
        if inspect(&mirror, &source_path).status == "ready" {
            // The whole point of the mirror is that either side can rebuild
            // the other without throwing away its history.
            seed_mirror(&mirror, &primary)?;
        } else {
            preserve_invalid(&primary)?;
            fs::create_dir_all(&primary).map_err(|e| e.to_string())?;
            make_private(primary.parent().unwrap_or(&primary))?;
            make_private(&primary)?;
            let repo = Repository::init(&primary).map_err(|e| e.to_string())?;
            fs::write(primary.join(SOURCE_FILE), format!("{}\n", normalized_source(&source_path))).map_err(|e| e.to_string())?;
            fs::write(primary.join(RECOVERY_FILE), "# Vault recovery\n\nEach Git revision of `vault.vlt` is a complete encrypted vault snapshot. To recover, check out the desired revision and copy `vault.vlt` to the source path recorded in `SOURCE_PATH.txt`. Keep the original file until recovery is verified.\n").map_err(|e| e.to_string())?;
            atomic_copy(Path::new(&vault_path), &primary.join(VAULT_FILE))?;
            commit(&repo, "Initial vault backup", unix_timestamp()?)?;
        }
    }
    seed_mirror(&primary, &mirror)?;
    let status = inspect_pair(&primary, &mirror, &source_path);
    if status.status != "ready" { return Err(status.detail.unwrap_or_else(|| "history initialization failed validation".into())); }
    Ok(status)
}

#[tauri::command]
pub async fn history_checkpoint(app: tauri::AppHandle, source_path: String, vault_path: String, reason: Option<String>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || history_checkpoint_blocking(app, source_path, vault_path, reason))
        .await
        .map_err(|e| format!("history worker failed: {e}"))?
}

fn history_checkpoint_blocking(app: tauri::AppHandle, source_path: String, vault_path: String, reason: Option<String>) -> Result<bool, String> {
    let (primary_path, mirror_path, _guard) = lock_history(&app, &source_path)?;
    let status = reconcile_pair(&primary_path, &mirror_path, &source_path)?;
    if status.status != "ready" { return Err(format!("history is {}: {}", status.status, status.detail.unwrap_or_default())); }
    let primary = Repository::open(&primary_path).map_err(|e| e.to_string())?;
    let mirror = Repository::open(&mirror_path).map_err(|e| e.to_string())?;
    atomic_copy(Path::new(&vault_path), &primary_path.join(VAULT_FILE))?;
    atomic_copy(Path::new(&vault_path), &mirror_path.join(VAULT_FILE))?;
    let timestamp = unix_timestamp()?;
    let message = reason.as_deref().unwrap_or("Vault checkpoint");
    let changed = commit(&primary, message, timestamp)?;
    let mirror_changed = commit(&mirror, message, timestamp)?;
    let primary_head = primary.refname_to_id("HEAD").map_err(|e| e.to_string())?;
    let mirror_head = mirror.refname_to_id("HEAD").map_err(|e| e.to_string())?;
    if changed != mirror_changed || primary_head != mirror_head {
        return Err("secondary recovery history did not produce the same commit".into());
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("vault-history-test-{name}-{stamp}"))
    }

    fn make_ready(root: &Path, source: &Path, bytes: &[u8]) -> Repository {
        fs::create_dir_all(root).unwrap();
        fs::write(source, bytes).unwrap();
        let repo = Repository::init(root).unwrap();
        fs::write(root.join(SOURCE_FILE), format!("{}\n", normalized_source(&source.to_string_lossy()))).unwrap();
        fs::write(root.join(RECOVERY_FILE), "recovery").unwrap();
        atomic_copy(source, &root.join(VAULT_FILE)).unwrap();
        assert!(commit(&repo, "initial", 1_700_000_000).unwrap());
        repo
    }

    #[test]
    fn path_is_stable_and_distinguishes_same_names() {
        let base = Path::new("history-root");
        assert_eq!(history_dir(base, "C:\\one\\notes.vlt"), history_dir(base, "C:\\one\\notes.vlt"));
        assert_ne!(history_dir(base, "C:\\one\\notes.vlt"), history_dir(base, "C:\\two\\notes.vlt"));
    }

    #[test]
    fn validates_ownership_and_repository_integrity() {
        let parent = temp_dir("validation");
        fs::create_dir_all(&parent).unwrap();
        let source = parent.join("source.vlt");
        let repo_path = parent.join("repo");
        let repo = make_ready(&repo_path, &source, b"initial encrypted bytes");
        assert_eq!(inspect(&repo_path, &source.to_string_lossy()).status, "ready");

        fs::write(repo_path.join(SOURCE_FILE), "some-other-vault.vlt\n").unwrap();
        assert_eq!(inspect(&repo_path, &source.to_string_lossy()).status, "path_mismatch");
        drop(repo);
        fs::remove_dir_all(repo_path.join(".git")).unwrap();
        assert_eq!(inspect(&repo_path, &source.to_string_lossy()).status, "corrupt");
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn checkpoints_changed_bytes_only() {
        let parent = temp_dir("checkpoint");
        fs::create_dir_all(&parent).unwrap();
        let source = parent.join("source.vlt");
        let repo_path = parent.join("repo");
        let repo = make_ready(&repo_path, &source, b"version one");
        assert!(!commit(&repo, "unchanged", 1_700_000_001).unwrap());
        fs::write(&source, b"version two with attachment bytes").unwrap();
        atomic_copy(&source, &repo_path.join(VAULT_FILE)).unwrap();
        assert!(commit(&repo, "switch", 1_700_000_002).unwrap());
        assert_eq!(fs::read(repo_path.join(VAULT_FILE)).unwrap(), b"version two with attachment bytes");
        assert!(!commit(&repo, "unchanged again", 1_700_000_003).unwrap());
        drop(repo);
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn mirrored_repositories_produce_identical_commits() {
        let parent = temp_dir("mirror");
        fs::create_dir_all(&parent).unwrap();
        let source = parent.join("source.vlt");
        let primary_path = parent.join("primary");
        let mirror_path = parent.join("mirror");
        let primary = make_ready(&primary_path, &source, b"version one");
        drop(primary);
        seed_mirror(&primary_path, &mirror_path).unwrap();

        fs::write(&source, b"version two").unwrap();
        atomic_copy(&source, &primary_path.join(VAULT_FILE)).unwrap();
        atomic_copy(&source, &mirror_path.join(VAULT_FILE)).unwrap();
        let primary = Repository::open(&primary_path).unwrap();
        let mirror = Repository::open(&mirror_path).unwrap();
        assert!(commit(&primary, "checkpoint", 1_700_000_100).unwrap());
        assert!(commit(&mirror, "checkpoint", 1_700_000_100).unwrap());
        assert_eq!(primary.refname_to_id("HEAD").unwrap(), mirror.refname_to_id("HEAD").unwrap());
        assert_eq!(inspect_pair(&primary_path, &mirror_path, &source.to_string_lossy()).status, "ready");
        drop(primary);
        drop(mirror);
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn repairs_a_mirror_left_one_commit_behind() {
        let parent = temp_dir("repair-behind");
        fs::create_dir_all(&parent).unwrap();
        let source = parent.join("source.vlt");
        let primary_path = parent.join("primary");
        let mirror_path = parent.join("mirror");
        let primary = make_ready(&primary_path, &source, b"version one");
        drop(primary);
        seed_mirror(&primary_path, &mirror_path).unwrap();

        fs::write(&source, b"version two").unwrap();
        atomic_copy(&source, &primary_path.join(VAULT_FILE)).unwrap();
        let primary = Repository::open(&primary_path).unwrap();
        assert!(commit(&primary, "interrupted checkpoint", 1_700_000_100).unwrap());
        drop(primary);

        let broken = inspect_pair(&primary_path, &mirror_path, &source.to_string_lossy());
        assert_eq!(broken.status, "corrupt");
        let repaired = reconcile_pair(&primary_path, &mirror_path, &source.to_string_lossy()).unwrap();
        assert_eq!(repaired.status, "ready");
        assert_eq!(
            Repository::open(&primary_path).unwrap().refname_to_id("HEAD").unwrap(),
            Repository::open(&mirror_path).unwrap().refname_to_id("HEAD").unwrap(),
        );
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn does_not_overwrite_truly_diverged_histories() {
        let parent = temp_dir("keep-divergence");
        fs::create_dir_all(&parent).unwrap();
        let source = parent.join("source.vlt");
        let primary_path = parent.join("primary");
        let mirror_path = parent.join("mirror");
        let primary = make_ready(&primary_path, &source, b"version one");
        drop(primary);
        seed_mirror(&primary_path, &mirror_path).unwrap();

        fs::write(primary_path.join(VAULT_FILE), b"primary edit").unwrap();
        fs::write(mirror_path.join(VAULT_FILE), b"mirror edit").unwrap();
        let primary = Repository::open(&primary_path).unwrap();
        let mirror = Repository::open(&mirror_path).unwrap();
        assert!(commit(&primary, "primary", 1_700_000_100).unwrap());
        assert!(commit(&mirror, "mirror", 1_700_000_100).unwrap());
        let primary_head = primary.refname_to_id("HEAD").unwrap();
        let mirror_head = mirror.refname_to_id("HEAD").unwrap();
        drop(primary);
        drop(mirror);

        let status = reconcile_pair(&primary_path, &mirror_path, &source.to_string_lossy()).unwrap();
        assert_eq!(status.status, "corrupt");
        assert_eq!(Repository::open(&primary_path).unwrap().refname_to_id("HEAD").unwrap(), primary_head);
        assert_eq!(Repository::open(&mirror_path).unwrap().refname_to_id("HEAD").unwrap(), mirror_head);
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn preserving_twice_never_reuses_a_directory_name() {
        let parent = temp_dir("preserve");
        let target = parent.join("history");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("first"), b"one").unwrap();
        preserve_invalid(&target).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("second"), b"two").unwrap();
        preserve_invalid(&target).unwrap();
        let preserved = fs::read_dir(&parent).unwrap().count();
        assert_eq!(preserved, 2);
        fs::remove_dir_all(&parent).unwrap();
    }
}
