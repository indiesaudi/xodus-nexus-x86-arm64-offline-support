# Nexus Launcher 0.5.1

This update restores Age of Empires compatibility, improves DLC recognition and fixes startup issues in Toxic Commando and Forza Horizon 5, alongside Steam controller, Gaming Mode, networking and launcher upgrade improvements.

> [!NOTE]
> Nexus Launcher is being rewritten from Electron to Slint. Read more in [the announcement](https://github.com/domsvoboda/nexus-launcher/issues/630).

## Game compatibility and runtime

- Restore compatibility across all **Age of Empires** titles.
- Fix current-game license result handling in **John Carpenter's Toxic Commando**.
- Fix reading large package layouts used by **Forza Horizon 5**, addressing the **Installing... Please wait** startup failure.
- Fix media playback failures caused by Steam selecting incompatible FFmpeg libraries instead of the matching runtime libraries.
- Fix GameInput callback registration when games omit optional output parameters.
- Detect the official Proton BattlEye Runtime when it is already installed through Steam. Games still require publisher-enabled Proton support.

## DLC and licensing

- Supply genuine acquisition and start dates for verified owned games and add-ons, fixing missing ownership metadata used by affected games.
- Fix installed add-on detection when layouts contain Windows or UNC build-machine source paths, including affected **Resident Evil 2** layouts.
- Implement package dependency queries for registered framework, resource and optional packages, and report missing or unsupported dependencies accurately.

## Steam and controller support

- Restore Steam's overlay for launched games while keeping it out of the launcher and account service, preserving the Steam Input launch context.
- Keep Steam's inherited shader-cache settings from overriding the launcher's managed game caches, while preserving explicit game options.
- Keep controller input on the Steam keyboard without navigating the launcher underneath it, and preserve search results when the keyboard is dismissed.
- Highlight the whole search box when it receives controller focus.

## Library and Store

- Add **Verify and install** for supported games included in an owned bundle, with ownership and bundle membership checked before installation.
- Show clearer, scoped errors when Store metadata cannot be loaded.

## Interface and authentication

- Keep tooltips inside the launcher window and add a short hover delay, avoiding oversized native tooltip popups in Gaming Mode.
- Use fullscreen automatically only in Gaming Mode, preserving normal window placement and sizing on the desktop.
- Explain when a file or folder picker requires Desktop Mode instead of attempting an unsupported native dialog in Gaming Mode.
- Improve cancellation and cleanup of obsolete Chrome sign-in fallback operations.
- Fix account-service startup with long launcher profile paths.

## Networking and cloud saves

- Fix wildcard authentication endpoint matching so games request tokens for the correct service.
- Support extended WinHTTP request-header APIs used by games.
- Correct response headers after automatic decompression while preserving information about unsupported content encodings.
- Reject incomplete HTTP response bodies instead of accepting truncated data, and reduce repeated buffer allocations for larger responses.
- Show the correct device hostname in cloud-save lock and conflict messages without changing save locations or synchronization behavior.

## Runtime and component management

- Recognize verified managed runtime installations when checking whether offline permissions are available.
- Fix valid managed runtime installations being rejected when parent directories use symbolic links.

## Installation and security

- Add separate **Install** and **Upgrade** choices to the installer, with safe replacement of the launcher while preserving existing user data.
- Use consistent **Nexus Launcher** AppImage naming while retaining support for upgrading older installations.
- Update Electron to **45.3.0**, including security fixes.

## Updating

Use the **x86_64 AppImage** and keep the backend and your installed Standard or CachyOS runtime up to date to receive the complete set of fixes. Existing games, accounts, settings, prefixes and saves are preserved.

> [!CAUTION]
> **Nexus Launcher is an independent, unofficial project built on Xodus. It is not an official project or release from the upstream Xodus developers.**
>
> Please report Nexus Launcher issues only in the [Nexus Launcher repository](https://github.com/domsvoboda/nexus-launcher/issues). A problem in Nexus Launcher does not necessarily indicate a problem in upstream Xodus.

## Steam Deck and similar handhelds

Steam Deck and similar handheld support is experimental. I'm currently testing and debugging on virtualized SteamOS and Bazzite, so I can't fully verify how everything behaves on real handheld hardware. Please report any issues you encounter.

I'm looking to buy an older Steam Deck or a similar handheld compatible with Bazzite or SteamOS for development and testing. If you have one you'd be willing to sell, please message me on Reddit at [u/Embarrassed-Hall-617](https://www.reddit.com/user/Embarrassed-Hall-617/). Cosmetic damage and signs of wear don't matter, as long as the device's basic functions work.

## Contributions

Special thanks to:

- **@AceMedia** for the offline-runtime detection, search-box controller focus and Gaming Mode file-picker guidance.
- **@Suffdev** for the authentication endpoint matching and WinHTTP decompression fixes.

Thanks to everyone contributing translations, bug reports, logs and game compatibility testing.

Contributions are welcome:

- [Report bugs or request features](https://github.com/domsvoboda/nexus-launcher/issues).
- [Help translate Nexus Launcher on Tolgee](https://app.tolgee.io/projects/36162).
- [Contribute code or documentation](https://github.com/domsvoboda/nexus-launcher/blob/main/CONTRIBUTING.md).

Please include component versions and reproduction steps when reporting a problem.
