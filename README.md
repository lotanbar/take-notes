# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Storage model

Vault format v4 keeps only its format and PBKDF2 parameters plaintext. The encrypted manifest references independently encrypted, checksummed note and media objects. Note text is compressed before AES-256-GCM encryption only when the complete encoded envelope is smaller.

Autosaves also enter an encrypted local session journal for crash replay. A verified close rebuilds and reopens the current vault, publishes it atomically, checkpoints the single content-addressed Git recovery history, then clears the journal. Only newly added media is optimized by low-priority background workers: still images become AVIF when smaller, while audio becomes Opus and video or animated images become AV1/WebM when the verified output is smaller.

`npm run build:media-tools` reproducibly builds the pinned, LGPL-only 19 MB FFmpeg subset used offline for audio, video, and animated images. `npm run portable` produces a Windows x64 portable ZIP containing the application and that tool; it does not install anything on the target computer.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
