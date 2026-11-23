# Third-party notices

This package merges two MIT-licensed DeepSeek Harness plugins and distributes
compiled third-party binaries:

| Component | Source | Licence |
|---|---|---|
| `native/Everything64.dll` | [Everything SDK](https://www.voidtools.com/Everything-SDK.zip), voidtools | MIT, Copyright (C) 2016 David Carpenter / voidtools |
| `vendor/koffi`, `vendor/@koromix/koffi-win32-x64` | [koffi](https://github.com/Koromix/koffi) 3.3.4 | MIT, Copyright (C) Niels Martignène |
| `assets/icon-*.png` | [voidtools Everything](https://www.voidtools.com/) icon | MIT, Copyright (c) 2022 voidtools — see `assets/ICON-LICENSE.txt` |
| Rank tiers and query-term construction | [dsh-at-file-everything](https://github.com/backkom/dsh-at-file-everything) | MIT, Copyright (c) leaf |
| SDK bridge, worker isolation, tool cards | [dsh-plugin-everything](https://github.com/keyblues/dsh-plugin-everything) | MIT, Copyright (c) keyblues |

Everything itself is a separate product; this package queries an already-installed
Everything index and does not redistribute the Everything application.
