# mikutv-plugin-quark

Official [Quark Cloud Drive](https://pan.quark.cn) source plugin for [MikuTV](https://github.com/yuchanns/MikuTV) on Apple TV (tvOS).

## Features

- **Direct QR Code Sign-In** — Scan with the Quark mobile app directly on Apple TV via official Quark Web CAS (`uop.quark.cn` → `pan.quark.cn`). Credentials stay in tvOS Keychain with no third-party relay server.
- **Zero-Config Media Library View** — Automatically surfaces recently updated videos, maps root folders to Regions filters, folds multi-episode folders (including `Season` subfolders) into playable series collections, and supports folder drill-down and global drive search.
- **Adaptive Playback & Subtitles** — Supports Quark cloud-transcoded streams (`4K`, `2K`, `1080P`, `720P`, Dolby Vision) with seek preview sprite thumbnails alongside original direct streams, plus automatic matching for sibling `.vtt`, `.srt`, and `.ass`/`.ssa` subtitles.

## Install

In MikuTV on Apple TV, open **Settings → Plugins → Discover**, search for **Quark Drive** (or enter `yuchanns/mikutv-plugin-quark`), install, and scan the QR code with the Quark app.

## License

[Apache-2.0](LICENSE)
