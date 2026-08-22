use base64::{engine::general_purpose, Engine as _};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use std::time::Instant;
use xz2::stream::{Check, Filters, LzmaOptions, Stream};
use xz2::{read::XzDecoder, write::XzEncoder};

const MAGIC: &[u8; 4] = b"VNC1";
const HEADER_SIZE: usize = 45;
const EXTREME_PRESET: u32 = 9 | (1 << 31);
const ENVELOPE_PREFIX: &str = r#"{"format":"vault-note-compressed-v1","payload":""#;
const ENVELOPE_SUFFIX: &str = r#""}"#;

#[derive(Clone, Copy, Debug)]
enum Codec {
    None = 0,
    Deflate9 = 1,
    Brotli11 = 2,
    Zstd22 = 3,
    Lzma1Ultra = 4,
    Lzma2Ultra = 5,
}

impl Codec {
    fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Deflate9 => "deflate-9",
            Self::Brotli11 => "brotli-11",
            Self::Zstd22 => "zstd-22",
            Self::Lzma1Ultra => "lzma1-ultra",
            Self::Lzma2Ultra => "lzma2-ultra",
        }
    }
    fn from_name(value: &str) -> Result<Self, String> {
        match value {
            "none" => Ok(Self::None),
            "deflate-9" => Ok(Self::Deflate9),
            "brotli-11" => Ok(Self::Brotli11),
            "zstd-22" => Ok(Self::Zstd22),
            "lzma1-ultra" => Ok(Self::Lzma1Ultra),
            "lzma2-ultra" => Ok(Self::Lzma2Ultra),
            _ => Err(format!("unsupported compression codec: {value}")),
        }
    }
    fn from_id(value: u8) -> Result<Self, String> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::Deflate9),
            2 => Ok(Self::Brotli11),
            3 => Ok(Self::Zstd22),
            4 => Ok(Self::Lzma1Ultra),
            5 => Ok(Self::Lzma2Ultra),
            _ => Err("unsupported compression codec id".into()),
        }
    }
    fn memory_bytes(self) -> u64 {
        match self {
            Self::None => 0,
            Self::Deflate9 => 1 << 20,
            Self::Brotli11 => 64 << 20,
            Self::Zstd22 => 128 << 20,
            Self::Lzma1Ultra | Self::Lzma2Ultra => 256 << 20,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionResult {
    codec: String,
    data_b64: String,
    original_size: u64,
    stored_size: u64,
    saved_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRow {
    codec: String,
    original_size: u64,
    stored_size: u64,
    compression_ms: f64,
    decompression_ms: f64,
    memory_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    selected_codec: String,
    rows: Vec<BenchmarkRow>,
}

fn compress_raw(codec: Codec, input: &[u8]) -> Result<Vec<u8>, String> {
    match codec {
        Codec::None => Ok(input.to_vec()),
        Codec::Deflate9 => {
            let mut out = ZlibEncoder::new(Vec::new(), Compression::best());
            out.write_all(input).map_err(|e| e.to_string())?;
            out.finish().map_err(|e| e.to_string())
        }
        Codec::Brotli11 => {
            let mut out = Vec::new();
            {
                let mut writer = brotli::CompressorWriter::new(&mut out, 4096, 11, 24);
                writer.write_all(input).map_err(|e| e.to_string())?;
            }
            Ok(out)
        }
        Codec::Zstd22 => {
            zstd::stream::encode_all(Cursor::new(input), 22).map_err(|e| e.to_string())
        }
        Codec::Lzma1Ultra => {
            let options = LzmaOptions::new_preset(EXTREME_PRESET).map_err(|e| e.to_string())?;
            let stream = Stream::new_lzma_encoder(&options).map_err(|e| e.to_string())?;
            let mut writer = XzEncoder::new_stream(Vec::new(), stream);
            writer.write_all(input).map_err(|e| e.to_string())?;
            writer.finish().map_err(|e| e.to_string())
        }
        Codec::Lzma2Ultra => {
            let options = LzmaOptions::new_preset(EXTREME_PRESET).map_err(|e| e.to_string())?;
            let mut filters = Filters::new();
            filters.lzma2(&options);
            let stream =
                Stream::new_stream_encoder(&filters, Check::Crc64).map_err(|e| e.to_string())?;
            let mut writer = XzEncoder::new_stream(Vec::new(), stream);
            writer.write_all(input).map_err(|e| e.to_string())?;
            writer.finish().map_err(|e| e.to_string())
        }
    }
}

fn decompress_raw(codec: Codec, input: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    match codec {
        Codec::None => out.extend_from_slice(input),
        Codec::Deflate9 => {
            ZlibDecoder::new(input)
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
        }
        Codec::Brotli11 => {
            brotli::Decompressor::new(input, 4096)
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
        }
        Codec::Zstd22 => {
            out = zstd::stream::decode_all(Cursor::new(input)).map_err(|e| e.to_string())?
        }
        Codec::Lzma1Ultra => {
            let stream = Stream::new_lzma_decoder(u64::MAX).map_err(|e| e.to_string())?;
            XzDecoder::new_stream(input, stream)
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
        }
        Codec::Lzma2Ultra => {
            XzDecoder::new(input)
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
        }
    };
    Ok(out)
}

fn encode(codec: Codec, input: &[u8]) -> Result<Vec<u8>, String> {
    let payload = compress_raw(codec, input)?;
    let mut result = Vec::with_capacity(HEADER_SIZE + payload.len());
    result.extend_from_slice(MAGIC);
    result.push(codec as u8);
    result.extend_from_slice(&(input.len() as u64).to_le_bytes());
    result.extend_from_slice(&Sha256::digest(input));
    result.extend_from_slice(&payload);
    Ok(result)
}

fn decode(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() < HEADER_SIZE || &input[..4] != MAGIC {
        return Err("invalid compressed note header".into());
    }
    let codec = Codec::from_id(input[4])?;
    let expected = u64::from_le_bytes(
        input[5..13]
            .try_into()
            .map_err(|_| "invalid compressed note length")?,
    ) as usize;
    let expected_hash = &input[13..HEADER_SIZE];
    let result = decompress_raw(codec, &input[HEADER_SIZE..])?;
    if result.len() != expected {
        return Err("decompressed note length mismatch".into());
    }
    if Sha256::digest(&result).as_slice() != expected_hash {
        return Err("decompressed note checksum mismatch".into());
    }
    Ok(result)
}

fn base64_size(length: usize) -> usize {
    length.div_ceil(3) * 4
}

fn complete_envelope_size(encoded_length: usize) -> u64 {
    (ENVELOPE_PREFIX.len() + base64_size(encoded_length) + ENVELOPE_SUFFIX.len()) as u64
}

#[tauri::command]
pub async fn compress_note(data_b64: String, codec: String) -> Result<CompressionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let input = general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| e.to_string())?;
        let requested = Codec::from_name(&codec)?;
        let encoded = encode(requested, &input)?;
        let (chosen, bytes) = if encoded.len() < input.len() {
            (requested, encoded)
        } else {
            (Codec::None, input.clone())
        };
        let stored_size = bytes.len() as u64;
        Ok(CompressionResult {
            codec: chosen.name().into(),
            data_b64: general_purpose::STANDARD.encode(bytes),
            original_size: input.len() as u64,
            stored_size,
            saved_bytes: (input.len() as u64).saturating_sub(stored_size),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn decompress_note(data_b64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| e.to_string())?;
        Ok(general_purpose::STANDARD.encode(decode(&bytes)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn benchmark_note_compression(
    payloads_b64: Vec<String>,
) -> Result<BenchmarkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let payloads: Result<Vec<_>, _> = payloads_b64
            .into_iter()
            .map(|p| {
                general_purpose::STANDARD
                    .decode(p)
                    .map_err(|e| e.to_string())
            })
            .collect();
        let payloads = payloads?;
        let original_size = payloads.iter().map(|p| p.len() as u64).sum();
        let mut rows = Vec::new();
        for codec in [
            Codec::Deflate9,
            Codec::Brotli11,
            Codec::Zstd22,
            Codec::Lzma1Ultra,
            Codec::Lzma2Ultra,
        ] {
            let start = Instant::now();
            let encoded: Result<Vec<_>, _> = payloads.iter().map(|p| encode(codec, p)).collect();
            let encoded = encoded?;
            let compression_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            for item in &encoded {
                decode(item)?;
            }
            let decompression_ms = start.elapsed().as_secs_f64() * 1000.0;
            rows.push(BenchmarkRow {
                codec: codec.name().into(),
                original_size,
                stored_size: encoded
                    .iter()
                    .zip(&payloads)
                    .map(|(encoded, original)| {
                        complete_envelope_size(encoded.len()).min(original.len() as u64)
                    })
                    .sum(),
                compression_ms,
                decompression_ms,
                memory_bytes: codec.memory_bytes(),
            });
        }
        let minimum = rows.iter().map(|r| r.stored_size).min().unwrap_or(0);
        let threshold = minimum + minimum / 100;
        let selected = rows
            .iter()
            .filter(|r| r.stored_size <= threshold)
            .min_by(|a, b| a.decompression_ms.total_cmp(&b.decompression_ms))
            .map(|r| r.codec.clone())
            .unwrap_or_else(|| "none".into());
        Ok(BenchmarkResult {
            selected_codec: selected,
            rows,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_codec_round_trips() {
        for c in [
            Codec::Deflate9,
            Codec::Brotli11,
            Codec::Zstd22,
            Codec::Lzma1Ultra,
            Codec::Lzma2Ultra,
        ] {
            let encoded = encode(c, b"hello hello hello hello").unwrap();
            assert_eq!(decode(&encoded).unwrap(), b"hello hello hello hello");
        }
    }
    #[test]
    fn corrupt_payload_is_rejected() {
        assert!(decode(b"VNC1\x01\x00").is_err());
        let mut encoded = encode(Codec::Deflate9, b"checksum-protected note payload").unwrap();
        let last = encoded.len() - 1;
        encoded[last] ^= 1;
        assert!(decode(&encoded).is_err());
    }
    #[test]
    fn complete_envelope_size_includes_header_and_base64() {
        assert!(complete_envelope_size(HEADER_SIZE) > HEADER_SIZE as u64);
    }
}
