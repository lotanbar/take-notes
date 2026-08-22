use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{codecs::webp::WebPDecoder, AnimationDecoder, ImageFormat};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResult {
    data: String,
    mime_type: String,
    codec: String,
    source_hash: String,
    output_hash: String,
    source_size: u64,
    output_size: u64,
    accepted: bool,
}

fn executable(app: &tauri::AppHandle, name: &str) -> PathBuf {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    app.path()
        .resource_dir()
        .ok()
        .map(|p| p.join("tools").join(&filename))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(filename))
}

fn background_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
    }
    command
}

fn temp_paths(extension: &str, output_extension: &str) -> Result<(PathBuf, PathBuf), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join("vault-notes-media");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok((
        dir.join(format!("{stamp}.{extension}")),
        dir.join(format!("{stamp}.out.{output_extension}")),
    ))
}

fn extension(mime: &str) -> &'static str {
    match mime {
        "image/gif" => "gif",
        "image/apng" | "image/png" => "png",
        "image/webp" => "webp",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn remove(path: &Path) {
    let _ = fs::remove_file(path);
}

fn remove_tree(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

fn animated_webp_frames(source: &[u8], input: &Path) -> Result<(PathBuf, PathBuf), String> {
    const OUTPUT_FPS: f64 = 15.0;
    const MAX_OUTPUT_FRAMES: usize = 18_000;
    let decoder = WebPDecoder::new(BufReader::new(Cursor::new(source)))
        .map_err(|e| format!("decoding animated WebP failed: {e}"))?;
    if !decoder.has_animation() {
        return Err("WebP was marked animated but contains no animation".into());
    }
    let directory = input.with_extension("webp-frames");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut elapsed_ms = 0.0;
        let mut written = 0usize;
        for frame in decoder.into_frames() {
            let frame = frame.map_err(|e| format!("decoding animated WebP frame failed: {e}"))?;
            let (numerator, denominator) = frame.delay().numer_denom_ms();
            elapsed_ms += f64::from(numerator) / f64::from(denominator.max(1));
            let target_count = ((elapsed_ms * OUTPUT_FPS / 1000.0).ceil() as usize).max(1);
            let buffer = frame.into_buffer();
            while written < target_count {
                if written >= MAX_OUTPUT_FRAMES {
                    return Err("animated WebP is too long to optimize safely".into());
                }
                written += 1;
                buffer
                    .save_with_format(
                        directory.join(format!("frame-{written:06}.png")),
                        ImageFormat::Png,
                    )
                    .map_err(|e| format!("staging animated WebP frame failed: {e}"))?;
            }
        }
        if written == 0 {
            return Err("animated WebP contains no decodable frames".into());
        }
        Ok(directory.join("frame-%06d.png"))
    })();
    match result {
        Ok(pattern) => Ok((directory, pattern)),
        Err(error) => {
            remove_tree(&directory);
            Err(error)
        }
    }
}

fn complete_size(data: &[u8], mime_type: &str, codec: &str) -> usize {
    data.len() + mime_type.len() + codec.len()
}

#[tauri::command]
pub async fn optimize_media(
    app: tauri::AppHandle,
    data: String,
    mime_type: String,
) -> Result<MediaResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = STANDARD.decode(data).map_err(|e| e.to_string())?;
        let is_audio = mime_type.starts_with("audio/");
        let animated = matches!(
            mime_type.as_str(),
            "image/gif" | "image/apng" | "image/webp"
        );
        let is_video = mime_type.starts_with("video/") || animated;
        if !is_audio && !is_video {
            return Err("media type does not require FFmpeg optimization".into());
        }
        let out_ext = if is_audio { "opus" } else { "webm" };
        let (input, output) = temp_paths(extension(&mime_type), out_ext)?;
        fs::write(&input, &source).map_err(|e| e.to_string())?;
        let webp_frames = if mime_type == "image/webp" {
            match animated_webp_frames(&source, &input) {
                Ok(frames) => Some(frames),
                Err(error) => {
                    remove(&input);
                    remove(&output);
                    return Err(error);
                }
            }
        } else {
            None
        };
        let ffmpeg = executable(&app, "ffmpeg");
        let mut command = background_command(&ffmpeg);
        command.args(["-nostdin", "-y", "-v", "error"]);
        if let Some((_, pattern)) = &webp_frames {
            command.args(["-framerate", "15", "-i"]).arg(pattern);
        } else {
            command.arg("-i").arg(&input);
        }
        if is_audio {
            command.args([
                "-vn",
                "-ac",
                "1",
                "-c:a",
                "libopus",
                "-b:a",
                "24k",
                "-application",
                "voip",
            ]);
        } else {
            command.args([
                "-vf",
                "scale=1280:720:force_original_aspect_ratio=decrease,fps=15",
                "-c:v",
                "libaom-av1",
                "-crf",
                "40",
                "-b:v",
                "0",
                "-an",
                "-row-mt",
                "1",
            ]);
        }
        let status = match command.arg(&output).status() {
            Ok(status) => status,
            Err(error) => {
                remove(&input);
                remove(&output);
                if let Some((directory, _)) = &webp_frames {
                    remove_tree(directory);
                }
                return Err(format!("offline FFmpeg tool is unavailable: {error}"));
            }
        };
        if !status.success() {
            remove(&input);
            remove(&output);
            if let Some((directory, _)) = &webp_frames {
                remove_tree(directory);
            }
            return Err("media conversion failed".into());
        }
        let converted = match fs::read(&output) {
            Ok(converted) => converted,
            Err(error) => {
                remove(&input);
                remove(&output);
                if let Some((directory, _)) = &webp_frames {
                    remove_tree(directory);
                }
                return Err(error.to_string());
            }
        };
        let verified = background_command(&ffmpeg)
            .args(["-nostdin", "-v", "error", "-i"])
            .arg(&output)
            .args(["-f", "null", "-"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        remove(&input);
        remove(&output);
        if let Some((directory, _)) = &webp_frames {
            remove_tree(directory);
        }
        if !verified {
            return Err("converted media did not decode successfully".into());
        }
        let converted_mime = if is_audio { "audio/opus" } else { "video/webm" };
        let converted_codec = if is_audio {
            "opus-24k-mono"
        } else {
            "av1-webm-720p15"
        };
        let accepted = complete_size(&converted, converted_mime, converted_codec)
            < complete_size(&source, &mime_type, "original");
        let result = if accepted { &converted } else { &source };
        Ok(MediaResult {
            data: STANDARD.encode(result),
            mime_type: if accepted { converted_mime } else { &mime_type }.into(),
            codec: if accepted {
                converted_codec
            } else {
                "original"
            }
            .into(),
            source_hash: hash(&source),
            output_hash: hash(result),
            source_size: source.len() as u64,
            output_size: result.len() as u64,
            accepted,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_FRAME_WEBP: &str = "UklGRsAAAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAA8AAA8AAMgAAAJWUDggMAAAANABAJ0BKhAAEAACADQloAJ0ugH4AAOwAP7w6Pf/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAADwAADwAAyAAAAFZQOCAsAAAAlAEAnQEqEAAQAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=";

    #[test]
    fn complete_envelope_must_be_smaller() {
        let original = vec![0; 100];
        let almost_as_large = vec![0; 99];
        assert!(
            complete_size(&almost_as_large, "video/webm", "av1-webm-720p15")
                >= complete_size(&original, "video/mp4", "original")
        );
    }

    #[test]
    fn animated_webp_is_staged_as_motion_frames() {
        let source = STANDARD.decode(TWO_FRAME_WEBP).unwrap();
        let input = std::env::temp_dir().join(format!(
            "vault-notes-webp-test-{}-{}.webp",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (directory, pattern) = animated_webp_frames(&source, &input).unwrap();
        assert_eq!(pattern.file_name().unwrap(), "frame-%06d.png");
        let frames: Vec<_> = fs::read_dir(&directory).unwrap().flatten().collect();
        assert!(frames.len() >= 2);
        for frame in frames {
            let decoded = image::open(frame.path()).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (16, 16));
        }
        remove_tree(&directory);
    }
}
