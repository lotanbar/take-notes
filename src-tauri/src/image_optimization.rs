use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{codecs::avif::AvifEncoder, ExtendedColorType, ImageEncoder};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const AVIF_SPEED: u8 = 8;
const AVIF_QUALITY: u8 = 35;
const ENCODER_THREADS: usize = 1;
const MAX_ENCRYPTED_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_DECODED_PIXELS: u64 = 50_000_000;
const WORKER_FLAG: &str = "--avif-worker";
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(25);

type SharedChild = Arc<Mutex<Child>>;

#[derive(Default)]
struct WorkerRegistry {
    workers: HashMap<String, SharedChild>,
    cancelled_before_start: HashSet<String>,
}

fn worker_registry() -> &'static Mutex<WorkerRegistry> {
    static REGISTRY: OnceLock<Mutex<WorkerRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(WorkerRegistry::default()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizedImage {
    mime_type: String,
    size: usize,
    data: String,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingImageEntry {
    note_id: String,
    image_id: String,
}

fn hash_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.contains(['\r', '\n']) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn pending_dir(app: &tauri::AppHandle, vault_key: &str) -> Result<PathBuf, String> {
    let mut dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    dir.push("pending-inline-images");
    dir.push(hash_hex(vault_key));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("creating pending image directory failed: {e}"))?;
    Ok(dir)
}

fn media_tool(app: &tauri::AppHandle) -> PathBuf {
    let filename = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    app.path()
        .resource_dir()
        .ok()
        .map(|path| path.join("tools").join(filename))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(filename))
}

fn pending_path(
    app: &tauri::AppHandle,
    vault_key: &str,
    image_id: &str,
) -> Result<PathBuf, String> {
    validate_id(image_id, "image id")?;
    Ok(pending_dir(app, vault_key)?.join(format!("{}.pending", hash_hex(image_id))))
}

fn read_pending_header(path: &Path) -> Result<(String, String), String> {
    let file = File::open(path).map_err(|e| format!("opening pending image failed: {e}"))?;
    let mut reader = BufReader::new(file);
    let mut note_id = String::new();
    let mut image_id = String::new();
    reader.read_line(&mut note_id).map_err(|e| e.to_string())?;
    reader.read_line(&mut image_id).map_err(|e| e.to_string())?;
    let note_id = note_id.trim_end_matches(['\r', '\n']).to_string();
    let image_id = image_id.trim_end_matches(['\r', '\n']).to_string();
    validate_id(&note_id, "note id")?;
    validate_id(&image_id, "image id")?;
    Ok((note_id, image_id))
}

#[tauri::command]
pub fn pending_image_write(
    app: tauri::AppHandle,
    vault_key: String,
    note_id: String,
    image_id: String,
    encrypted_payload: String,
) -> Result<(), String> {
    validate_id(&note_id, "note id")?;
    validate_id(&image_id, "image id")?;
    if encrypted_payload.len() > MAX_ENCRYPTED_PAYLOAD_BYTES {
        return Err("encrypted pending screenshot exceeds the recovery limit".into());
    }
    let target = pending_path(&app, &vault_key, &image_id)?;
    if target.exists() {
        return Ok(());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = target.with_extension(format!("{}.tmp", stamp));
    {
        let mut file =
            File::create(&temporary).map_err(|e| format!("creating pending image failed: {e}"))?;
        writeln!(file, "{note_id}").map_err(|e| e.to_string())?;
        writeln!(file, "{image_id}").map_err(|e| e.to_string())?;
        file.write_all(encrypted_payload.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&temporary, &target).map_err(|e| format!("publishing pending image failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn pending_image_list(
    app: tauri::AppHandle,
    vault_key: String,
) -> Result<Vec<PendingImageEntry>, String> {
    let dir = pending_dir(&app, &vault_key)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("pending") {
            continue;
        }
        if let Ok((note_id, image_id)) = read_pending_header(&path) {
            entries.push(PendingImageEntry { note_id, image_id });
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn pending_image_read(
    app: tauri::AppHandle,
    vault_key: String,
    image_id: String,
) -> Result<String, String> {
    let path = pending_path(&app, &vault_key, &image_id)?;
    let mut contents = String::new();
    File::open(path)
        .map_err(|e| format!("opening pending image failed: {e}"))?
        .read_to_string(&mut contents)
        .map_err(|e| format!("reading pending image failed: {e}"))?;
    let mut parts = contents.splitn(3, '\n');
    parts.next();
    parts.next();
    parts
        .next()
        .map(str::to_string)
        .ok_or_else(|| "pending image is corrupt".into())
}

#[tauri::command]
pub fn pending_image_delete(
    app: tauri::AppHandle,
    vault_key: String,
    image_id: String,
) -> Result<(), String> {
    let path = pending_path(&app, &vault_key, &image_id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("deleting pending image failed: {error}")),
    }
}

fn encode_avif(input: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let decoded =
        image::load_from_memory(input).map_err(|e| format!("decoding screenshot failed: {e}"))?;
    let width = decoded.width();
    let height = decoded.height();
    if u64::from(width) * u64::from(height) > MAX_DECODED_PIXELS {
        return Err("screenshot dimensions are too large to optimize safely".into());
    }
    let rgba = decoded.to_rgba8();
    let mut output = Vec::new();
    AvifEncoder::new_with_speed_quality(&mut output, AVIF_SPEED, AVIF_QUALITY)
        .with_num_threads(Some(ENCODER_THREADS))
        .write_image(rgba.as_raw(), width, height, ExtendedColorType::Rgba8)
        .map_err(|e| format!("encoding AVIF failed: {e}"))?;
    let header_is_avif = output.get(4..8) == Some(b"ftyp")
        && output
            .get(8..32)
            .is_some_and(|header| header.windows(4).any(|brand| brand == b"avif"));
    if !header_is_avif {
        return Err("AVIF encoder returned an invalid file".into());
    }
    Ok((output, width, height))
}

fn worker_paths(image_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let mut dir = std::env::temp_dir();
    dir.push("vault-notes-avif-workers");
    fs::create_dir_all(&dir).map_err(|e| format!("creating AVIF worker directory failed: {e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let stem = format!("{}-{stamp}", hash_hex(image_id));
    Ok((
        dir.join(format!("{stem}.input")),
        dir.join(format!("{stem}.output")),
    ))
}

fn write_worker_output(path: &Path, avif: &[u8], width: u32, height: u32) -> Result<(), String> {
    let mut output = Vec::with_capacity(8 + avif.len());
    output.extend_from_slice(&width.to_le_bytes());
    output.extend_from_slice(&height.to_le_bytes());
    output.extend_from_slice(avif);
    fs::write(path, output).map_err(|e| format!("writing AVIF worker output failed: {e}"))
}

fn read_worker_output(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    let output = fs::read(path).map_err(|e| format!("reading AVIF worker output failed: {e}"))?;
    if output.len() < 8 {
        return Err("AVIF worker returned an incomplete result".into());
    }
    let width = u32::from_le_bytes(output[0..4].try_into().map_err(|_| "invalid AVIF width")?);
    let height = u32::from_le_bytes(output[4..8].try_into().map_err(|_| "invalid AVIF height")?);
    Ok((output[8..].to_vec(), width, height))
}

fn run_worker(input_path: &Path, output_path: &Path, verifier: &Path) -> Result<(), String> {
    let input =
        fs::read(input_path).map_err(|e| format!("reading AVIF worker input failed: {e}"))?;
    let (avif, width, height) = encode_avif(&input)?;
    fs::write(output_path, &avif).map_err(|e| format!("staging AVIF verification failed: {e}"))?;
    let mut command = Command::new(verifier);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
    }
    let verified = command
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(output_path)
        .args(["-f", "null", "-"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !verified {
        return Err("encoded AVIF did not decode successfully".into());
    }
    write_worker_output(output_path, &avif, width, height)
}

pub fn run_worker_from_args() -> Option<i32> {
    let mut args = std::env::args_os();
    args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new(WORKER_FLAG)) {
        return None;
    }
    let Some(input_path) = args.next() else {
        return Some(2);
    };
    let Some(output_path) = args.next() else {
        return Some(2);
    };
    let Some(verifier) = args.next() else {
        return Some(2);
    };
    Some(
        match run_worker(
            Path::new(&input_path),
            Path::new(&output_path),
            Path::new(&verifier),
        ) {
            Ok(()) => 0,
            Err(_) => 1,
        },
    )
}

fn remove_worker(image_id: &str, expected: &SharedChild) -> bool {
    let mut registry = worker_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let matches = registry
        .workers
        .get(image_id)
        .is_some_and(|current| Arc::ptr_eq(current, expected));
    if matches {
        registry.workers.remove(image_id);
    }
    registry.cancelled_before_start.remove(image_id)
}

#[tauri::command]
pub async fn optimize_inline_image(
    app: tauri::AppHandle,
    data: String,
    image_id: String,
) -> Result<OptimizedImage, String> {
    validate_id(&image_id, "image id")?;
    tauri::async_runtime::spawn_blocking(move || {
        let input = STANDARD
            .decode(data.as_bytes())
            .map_err(|e| format!("decoding screenshot data failed: {e}"))?;
        let (input_path, output_path) = worker_paths(&image_id)?;
        fs::write(&input_path, input)
            .map_err(|e| format!("writing AVIF worker input failed: {e}"))?;

        let executable =
            std::env::current_exe().map_err(|e| format!("locating AVIF worker failed: {e}"))?;
        let verifier = media_tool(&app);
        let child = {
            let mut registry = worker_registry()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if registry.cancelled_before_start.remove(&image_id) {
                let _ = fs::remove_file(&input_path);
                return Err("image optimization canceled".into());
            }
            if registry.workers.contains_key(&image_id) {
                let _ = fs::remove_file(&input_path);
                return Err("this image is already being optimized".into());
            }
            let mut command = Command::new(executable);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
            }
            let child = command
                .arg(WORKER_FLAG)
                .arg(&input_path)
                .arg(&output_path)
                .arg(&verifier)
                .spawn()
                .map_err(|e| format!("starting AVIF worker failed: {e}"))?;
            let shared = Arc::new(Mutex::new(child));
            registry
                .workers
                .insert(image_id.clone(), Arc::clone(&shared));
            shared
        };

        let status = loop {
            let status = child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .try_wait()
                .map_err(|e| format!("waiting for AVIF worker failed: {e}"))?;
            if let Some(status) = status {
                break status;
            }
            thread::sleep(WORKER_POLL_INTERVAL);
        };
        let was_cancelled = remove_worker(&image_id, &child);
        let result = if was_cancelled {
            Err("image optimization canceled".into())
        } else if !status.success() {
            Err("AVIF worker failed".into())
        } else {
            read_worker_output(&output_path)
        };
        let _ = fs::remove_file(&input_path);
        let _ = fs::remove_file(&output_path);
        let (avif, width, height) = result?;
        Ok(OptimizedImage {
            mime_type: "image/avif".into(),
            size: avif.len(),
            data: STANDARD.encode(avif),
            width,
            height,
        })
    })
    .await
    .map_err(|e| format!("image optimization worker failed: {e}"))?
}

#[tauri::command]
pub fn cancel_inline_image_optimization(image_id: String) -> Result<bool, String> {
    validate_id(&image_id, "image id")?;
    let child = {
        let mut registry = worker_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.cancelled_before_start.insert(image_id.clone());
        registry.workers.get(&image_id).cloned()
    };
    let Some(child) = child else { return Ok(false) };
    child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .kill()
        .map_err(|e| format!("canceling AVIF worker failed: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_valid_avif() {
        let mut png_bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_bytes, 32, 16);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&vec![180; 32 * 16 * 4]).unwrap();
        }
        let (avif, width, height) = encode_avif(&png_bytes).unwrap();
        assert_eq!((width, height), (32, 16));
        assert_eq!(&avif[4..8], b"ftyp");
        assert!(avif[8..32].windows(4).any(|brand| brand == b"avif"));
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_targets_only_the_requested_image_worker() {
        let first_id = format!("cancel-target-{}", std::process::id());
        let second_id = format!("keep-running-{}", std::process::id());
        let first = Arc::new(Mutex::new(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 10"])
                .spawn()
                .unwrap(),
        ));
        let second = Arc::new(Mutex::new(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 10"])
                .spawn()
                .unwrap(),
        ));
        {
            let mut registry = worker_registry().lock().unwrap();
            registry
                .workers
                .insert(first_id.clone(), Arc::clone(&first));
            registry
                .workers
                .insert(second_id.clone(), Arc::clone(&second));
        }

        assert!(cancel_inline_image_optimization(first_id.clone()).unwrap());
        thread::sleep(Duration::from_millis(100));
        assert!(first.lock().unwrap().try_wait().unwrap().is_some());
        assert!(second.lock().unwrap().try_wait().unwrap().is_none());

        second.lock().unwrap().kill().unwrap();
        let mut registry = worker_registry().lock().unwrap();
        registry.workers.remove(&first_id);
        registry.workers.remove(&second_id);
        registry.cancelled_before_start.remove(&first_id);
    }
}
