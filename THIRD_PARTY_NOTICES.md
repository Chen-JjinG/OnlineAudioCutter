# Third-party notices

The application vendors the following unmodified release assets. They can run offline; no CDN requests are needed at runtime.

| Dependency | Version | Upstream | License |
| --- | --- | --- | --- |
| wavesurfer.js, Regions, Minimap | 7.12.12 | https://github.com/katspaugh/wavesurfer.js | BSD-3-Clause |
| wasm-media-encoders JavaScript wrapper | 0.7.0 | https://github.com/arseneyr/wasm-media-encoders | MIT |
| fflate | 0.8.2 | https://github.com/101arrowz/fflate | MIT |
| LAME, compiled into `mp3.wasm` | Source revision below | https://github.com/arseneyr/lame | LGPL-2.1-or-later |
| libogg, compiled into `ogg.wasm` | Source revision below | https://github.com/xiph/ogg | BSD-3-Clause |
| libvorbis, compiled into `ogg.wasm` | Source revision below | https://github.com/xiph/vorbis | BSD-3-Clause |

Full notices are included in `vendor/licenses/`. The MP3 and Vorbis WASM binaries are taken from the published `wasm-media-encoders@0.7.0` package and have not been modified.

## Encoder source and rebuilding

The upstream `wasm-media-encoders` repository contains the encoder bindings and build files, with codec source in Git submodules:

- LAME: `98db548e8e851defbba3184125ce10725355c332`
- libogg: `bada45718453ac27b56773ae663f7e65112f6a6e`
- libvorbis: `0657aee69dec8508a0011f47f3b69d7538e9d262`

Source locations:

- https://github.com/arseneyr/lame/tree/98db548e8e851defbba3184125ce10725355c332
- https://github.com/xiph/ogg/tree/bada45718453ac27b56773ae663f7e65112f6a6e
- https://github.com/xiph/vorbis/tree/0657aee69dec8508a0011f47f3b69d7538e9d262

Follow the upstream repository's build instructions to rebuild the WASM encoders. The multi-file application loads `vendor/mp3.wasm` and `vendor/ogg.wasm` as separate, replaceable modules; replacing them and running `npm run build` regenerates the standalone HTML with those modules. The JavaScript wrapper and WASM library version strings must match.
