<div align="center">

<img src="docs/assets/logo.svg" width="88" alt="DriveAtlas logo">

# DriveAtlas

**Know every drive you own, and every file on it, even when the drive is in a drawer.**

A lightweight, private catalog for USB sticks, SD cards, HDDs, SSDs and NVMe drives.
Runs on your Windows PC and your Android phone. No cloud, no hosting, no subscription.

![Status](https://img.shields.io/badge/status-Phase%201%20in%20progress-0F766E?style=flat-square)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Android-334155?style=flat-square)
![Runtime](https://img.shields.io/badge/runtime-Node.js%2024-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/license-Personal%20Use-B45309?style=flat-square)

[Design sheet](docs/DriveAtlas-Design-Sheet.md) · [UI mockups](design/DriveAtlas-UI-Mockups.pdf) · [Roadmap](#roadmap) · [License](LICENSE.md)

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/07-pc-home-dark.png">
  <img src="design/ui-mockups/png/01-pc-home.png" alt="DriveAtlas home screen on Windows: storage summary, connected drives, alerts and recent scans">
</picture>

<p align="center"><sub>Mockup of the Windows app. It follows your system theme; GitHub shows the dark version if your GitHub theme is dark.</sub></p>

## Why DriveAtlas

If you own a drawer full of drives, you know the problem: *which one has the 2019 wedding videos? Is that old laptop HDD still healthy? Did I lend the T7 to someone?*

DriveAtlas keeps one catalog of every storage device you own. Plug a drive in once, let it scan, and from then on you can search its files, check its health and find where you keep it, even when it is not plugged in.

- **Search across every drive**, plugged in or not. Results tell you which drive and which shelf.
- **Only names are stored.** File names, folders, sizes and dates. File contents are never copied.
- **Your data stays with you.** It lives on your PC and your phone, synced over your own Wi-Fi.
- **Light on your machine.** Uses the Node.js and Edge you already have. No Electron, no database server.

## Features

<table>
<tr>
<td width="50%" valign="top">

**Catalog every drive**
- 15 drive types: USB, SD, microSD, CFexpress, HDD 3.5"/2.5", external HDD, SATA, mSATA, M.2 SATA, M.2 NVMe, U.2, portable SSD, enclosures, and Other with your own label
- Your own names, advertised vs usable capacity, interface, speeds, serial
- Status: In PC, Plugged in, Stored, Lent out, Retired
- Collections, tags, locations (shelf, box, drawer)

**Map every file**
- Scan the full folder tree of any drive
- Photo and video details (resolution, duration, date taken)
- Quick fingerprints to spot the same file on different drives
- Browse a drive's folders even when it sits in a drawer

**Know drive health**
- Health %, temperature, power-on hours, bad sectors (HDD, SSD, NVMe)
- Uses Windows' own data plus a bundled `smartctl`
- Health history chart and early warnings

</td>
<td width="50%" valign="top">

**Smart when you plug in**
- Recognises known drives instantly
- Fills in details for new drives automatically
- Detects changes (partitions, Windows removed, now external) and asks before updating
- Partition map, file systems, BitLocker, bootable USB detection (Windows installer, Ventoy, Linux live, Hiren's)

**Organize and insights**
- QR labels: A4 sticker sheet, label printer, or one label on screen
- Reminders: power on cold-storage drives, health checks, lent drives
- Duplicate finder, scan history with changes, storage charts

**Yours, everywhere**
- Android app with a full offline copy
- Syncs with your PC over your own Wi-Fi, encrypted
- One backup file restores everything on a new laptop
- Dark and light mode on both apps

</td>
</tr>
</table>

## Screenshots

### Windows

<table>
<tr>
<td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/08-pc-drives-dark.png"><img src="design/ui-mockups/png/02-pc-drives.png" alt="Drives grouped by status"></picture><p align="center"><sub>Drives, grouped by status</sub></p></td>
<td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/09-pc-drive-detail-dark.png"><img src="design/ui-mockups/png/03-pc-drive-detail.png" alt="Drive detail with partitions and health"></picture><p align="center"><sub>Drive detail: partitions and health</sub></p></td>
</tr>
<tr>
<td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/10-pc-search-dark.png"><img src="design/ui-mockups/png/04-pc-search.png" alt="Search across all drives"></picture><p align="center"><sub>Search across all drives</sub></p></td>
<td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/12-pc-scan-dark.png"><img src="design/ui-mockups/png/06-pc-scan.png" alt="Scanning a drive"></picture><p align="center"><sub>Scanning a drive</sub></p></td>
</tr>
</table>

### Android

<table>
<tr>
<td width="25%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/19-phone-home-dark.png"><img src="design/ui-mockups/png/13-phone-home.png" alt="Phone home"></picture><p align="center"><sub>Home</sub></p></td>
<td width="25%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/20-phone-drives-dark.png"><img src="design/ui-mockups/png/14-phone-drives.png" alt="Phone drives list"></picture><p align="center"><sub>Drives</sub></p></td>
<td width="25%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/21-phone-drive-detail-dark.png"><img src="design/ui-mockups/png/15-phone-drive-detail.png" alt="Bootable USB detail"></picture><p align="center"><sub>Bootable USB</sub></p></td>
<td width="25%"><picture><source media="(prefers-color-scheme: dark)" srcset="design/ui-mockups/png/23-phone-otg-scan-dark.png"><img src="design/ui-mockups/png/17-phone-otg-scan.png" alt="Scanning a USB drive on the phone"></picture><p align="center"><sub>OTG scan</sub></p></td>
</tr>
</table>

<sub>All 25 screens, light and dark: [gallery](design/DriveAtlas-UI-Mockups.html) · [PDF](design/DriveAtlas-UI-Mockups.pdf). Screens show example data.</sub>

## How it works

<img src="docs/images/architecture.png" alt="The laptop hub holds the catalog; the phone syncs a full copy on your Wi-Fi">

- **Hub on your PC.** A small Node.js process holds the catalog in a SQLite file, reads drive details through PowerShell and `smartctl`, and serves the app on your home network.
- **App window on Windows.** The interface opens in its own Edge or Chrome app window, pinned to the Start menu. No browser tabs, no installer bloat.
- **Android app.** The same interface packaged as an APK. It keeps a full offline copy and syncs with the hub when both are on the same Wi-Fi. Pairing is one QR scan.
- **Backups.** One encrypted backup file holds everything. Restore it on a new laptop and DriveAtlas comes back exactly as it was.

## Roadmap

| Phase | What ships | Status |
| --- | --- | --- |
| 0 · Design | Design sheet, UI mockups for Windows and Android | Done |
| 1 · PC app | Hub, drive catalog, plug-in and change detection, scanning, file browser, search, partitions, health, backup and restore | In progress |
| 2 · Android and sync | APK built by GitHub Actions, QR pairing, same Wi-Fi sync, offline copy, OTG scanning | Planned |
| 3 · Organize and insights | Locations and lent-out, QR labels, reminders, duplicates, scan history, charts, exports | Planned |

Full details: [design sheet](docs/DriveAtlas-Design-Sheet.md) ([PDF](docs/DriveAtlas-Design-Sheet.pdf)).

## Tech stack

| Part | Choice |
| --- | --- |
| Hub | Node.js 24 built-ins only: `node:http`, `node:sqlite` with full-text search, `node:crypto`, worker threads |
| Drive data | PowerShell storage cmdlets, `smartctl` from smartmontools |
| Interface | Preact + htm, plain CSS design tokens, hand-drawn SVG charts |
| Windows shell | Edge/Chrome app window, PowerShell tray icon and shortcuts |
| Android | Capacitor, SQLite, Storage Access Framework for OTG, ML Kit QR scanner |
| Builds | GitHub Actions builds and signs the APK |

## Getting started

The PC app is being built now (Phase 1). Setup steps will land here with the first release.

**You will need:** Windows 10 or 11, Node.js 22 or newer, and Microsoft Edge or Google Chrome. Android 9 or newer for the phone app.

## Project structure

```
DriveAtlas/
├── docs/                      Design sheet (Markdown, HTML, PDF), diagrams, logo
├── design/
│   ├── canvas/project/        Editable UI mockup sources
│   ├── ui-mockups/png/        One image per screen
│   ├── ui-mockups/html/       One standalone page per screen
│   └── DriveAtlas-UI-Mockups.{html,pdf}
├── tools/                     Scripts that rebuild the docs and mockup images
├── LICENSE.md
└── README.md
```

Rebuild the docs after editing their sources:

```bash
node tools/md2html.mjs docs/DriveAtlas-Design-Sheet.md docs/DriveAtlas-Design-Sheet.html
node tools/render-mockups.mjs
```

## Privacy

DriveAtlas never uploads anything anywhere. It reads file names, folder structure, sizes and dates, plus the first few kilobytes of photos and videos for their details and fingerprints. It never copies, moves or changes your files. Sync happens only between your own devices on your own Wi-Fi, encrypted with a key shared by QR code.

## License

DriveAtlas is free for **personal use**. Modifying it, redistributing it, publishing or showcasing a modified version, or using it commercially requires written permission from the author first. Talking about it, reviewing it and linking to this repository is welcome. See [LICENSE.md](LICENSE.md) for the full terms.

## Author

Made by **Sulman Ahmad** · [github.com/Sulman-Ahmad](https://github.com/Sulman-Ahmad)
