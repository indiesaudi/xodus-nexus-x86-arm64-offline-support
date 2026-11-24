<div align="center">

<img src="assets/icon.png" width="96" alt="Nexus Launcher" />

# Nexus Launcher for arm64

arm64 builds of [Nexus Launcher](https://github.com/domsvoboda/nexus-launcher), for Linux handhelds and
other arm64 devices, such as the ones armadaOS supports.

</div>

> [!CAUTION]
> **These are unofficial builds.** Upstream Nexus Launcher publishes only x86_64 AppImages; this repository
> builds its released code for arm64. It is not affiliated with the Nexus Launcher maintainers or the Xodus
> developers. Report problems that only happen in these arm64 builds [here](../../issues), and everything
> else to [Nexus Launcher](https://github.com/domsvoboda/nexus-launcher/issues).

For what the launcher does, how to use it and which games work, read the
[upstream README](https://github.com/domsvoboda/nexus-launcher#readme).

## Install

1. Download `Nexus-Launcher-<version>-arm64.AppImage` from [Releases](../../releases/latest).
2. Make it executable: `chmod +x Nexus-Launcher-*-arm64.AppImage`
3. Open it.

Upstream's installer downloads only from upstream, which has no arm64 build. To add the launcher to your
application menu (and install its system prerequisites), give the installer the AppImage you downloaded:

```sh
curl -fsSL https://raw.githubusercontent.com/domsvoboda/nexus-launcher/main/scripts/install.sh \
  | XODUS_NEXUS_APPIMAGE="$PWD/Nexus-Launcher-<version>-arm64.AppImage" bash
```

To uninstall, follow [upstream's instructions](https://github.com/domsvoboda/nexus-launcher#uninstall).

## Updates

Each upstream release gets a matching arm64 release here with the same version number, usually within a few
hours. The launcher's in-app updater checks this repository, so it offers you the next arm64 build.

## How the builds are made

[`arm64-release.yml`](.github/workflows/arm64-release.yml) checks upstream for new releases. For each one,
it checks out upstream's tagged commit, runs upstream's own checks and tests, and packages the AppImage on
an arm64 GitHub runner. Each release links the exact upstream commit it was built from.

The source is upstream's, with one change:
[`point-updater-at-fork.mjs`](.github/arm64/point-updater-at-fork.mjs) points the in-app updater at this
repository, as described in [Updates](#updates).

## What to expect on arm64

The launcher itself is native arm64. It downloads the rest from upstream, the same way the x86_64 build
does:

- **Backend:** upstream publishes native aarch64 builds.
- **Game runtime:** upstream's arm64 runtime is experimental. The Standard runtime family has arm64 releases;
  the CachyOS family is x86_64 only.
- **Games:** most Microsoft Store PC games are x86_64 Windows games. They run through FEX emulation and need
  working Vulkan graphics drivers, so performance and compatibility depend on your device.

## License

MIT, like upstream. See [LICENSE](LICENSE).
