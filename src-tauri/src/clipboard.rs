use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    mime_type: String,
    size: usize,
    data: String,
    width: usize,
    height: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContent {
    image: Option<ClipboardImage>,
    text: Option<String>,
}

fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn read_native_clipboard() -> Result<ClipboardContent, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = Clipboard::new().map_err(|e| format!("opening clipboard failed: {e}"))?;
        if let Ok(image) = clipboard.get_image() {
            let width = image.width;
            let height = image.height;
            let png = encode_png(width, height, image.bytes.as_ref())?;
            return Ok(ClipboardContent {
                image: Some(ClipboardImage {
                    mime_type: "image/png".into(),
                    size: png.len(),
                    data: STANDARD.encode(png),
                    width,
                    height,
                }),
                text: None,
            });
        }
        Ok(ClipboardContent { image: None, text: clipboard.get_text().ok() })
    })
    .await
    .map_err(|e| format!("clipboard worker failed: {e}"))?
}
