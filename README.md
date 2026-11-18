<a id="readme-top"></a>

<div align="center">

<img src="resources/logo/sidescreen-icon.png" alt="Side Screen" width="128"/>

<h1>Side Screen</h1>

<p><em>Use an Android or HarmonyOS tablet as a second display for your Mac.</em></p>

<p><a href="#harmonyos-usb">鸿蒙 7.0+ 平板给 Mac mini 当副屏 · USB 直连 · 平板免装 App</a></p>

<p>
  <img src="https://img.shields.io/github/v/release/tranvuongquocdat/SideScreen?style=for-the-badge&label=upstream%20release&color=blue" alt="Upstream release">
  <a href="https://github.com/tranvuongquocdat/SideScreen/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/tranvuongquocdat/SideScreen?style=for-the-badge&color=34C759" alt="License">
  </a>
  <a href="https://github.com/tranvuongquocdat/SideScreen/stargazers">
    <img src="https://img.shields.io/github/stars/tranvuongquocdat/SideScreen?style=for-the-badge&color=FF9500" alt="Stars">
  </a>
  <a href="https://github.com/tranvuongquocdat/SideScreen/releases">
    <img src="https://img.shields.io/github/downloads/tranvuongquocdat/SideScreen/total?style=for-the-badge&color=8E44AD&label=downloads" alt="Downloads">
  </a>
</p>

![Swift](https://img.shields.io/badge/Swift-FA7343?style=for-the-badge&logo=swift&logoColor=white)
![Kotlin](https://img.shields.io/badge/Kotlin-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white)
![macOS](https://img.shields.io/badge/macOS_13+-000000?style=for-the-badge&logo=apple&logoColor=white)
![Android](https://img.shields.io/badge/Android_8+-3DDC84?style=for-the-badge&logo=android&logoColor=white)
![Universal Binary](https://img.shields.io/badge/Universal_Binary-Apple_Silicon_+_Intel-000000?style=for-the-badge&logo=apple&logoColor=white)

</div>

---

<a id="harmonyos-usb"></a>

## 鸿蒙平板当 Mac mini 副屏

本项目 fork 自 [tranvuongquocdat/SideScreen](https://github.com/tranvuongquocdat/SideScreen)，沿用原项目的 MIT 许可证。这个分支给 SideScreen 加上了 **HarmonyOS 7.0+ 的 USB 副屏模式**。Mac mini 创建扩展桌面，平板用系统浏览器显示。平板免装 App，画面走 USB 数据线。

### 这个分支改了什么

- **USB 连接**。原版安卓 USB 模式用 `adb reverse`。鸿蒙端用华为的 `hdc rport`，由 [Mac 上的转发脚本](HarmonyClient/bridge.py) 建立连接。
- **平板播放和触控**。新增[浏览器播放器](HarmonyClient/viewer.js)，支持全屏、断线重连和画质回退。平板将[触摸位置和手势](HarmonyClient/touch.mjs)沿同一条 USB 连接传回 Mac，可直接点按和拖动副屏上的窗口，也可继续用 Mac 的键盘和鼠标。
- **分辨率适配**。复用原版的虚拟显示器、画面捕获和编码，在 [Mac 端](MacHost/Sources/AppDelegate.swift) 增加平板尺寸协商。连接时读取平板的物理分辨率，创建 60 Hz HiDPI 桌面，并优先尝试按原生像素传输。例如 2800×1840 的面板会用 1400×920 的桌面缩放，让文字大小合适，同时保留像素细节。
- **macOS 应用**。新增「鸿蒙副屏」中文窗口和独立的蓝色双屏图标。打开应用即可启动 USB 连接和串流，窗口提供连接状态、当前屏幕用途、重新连接和打开平板页面等操作。USB 工具和浏览器播放器随应用打包。
- **自动主副屏**。平板是 Mac 唯一的显示器时，自动作为主屏幕。连接其他显示器时，平板作为独立的扩展桌面，并随显示器插拔重新调整排列。

### 怎么用

已安装 Mac 应用时，在「应用程序」中双击 **鸿蒙副屏**，接上 USB 数据线并解锁平板。应用会自动连接并打开平板浏览器，点「全屏」即可。首次启动需允许屏幕录制。关闭 Mac 上的窗口后副屏继续工作，从菜单栏或按 `⌘Q` 退出应用会停止连接。

要用手指操作 Mac，在应用中打开「平板触控」，通过「打开辅助功能设置」允许「鸿蒙副屏」。部分 macOS 版本将这项设置显示为「设备控制和数据访问」。轻点是单击，双击可打开文件，滑动可以滚动页面。按住约半秒再移动可以拖动窗口，按住后原地松开是右键。高清、低延迟和全屏都支持触控。

应用内包含 USB 连接工具和播放器，运行时使用 Mac 上已安装的 Python 3。开发者可运行 `./scripts/build_harmony_mac.sh /Applications/鸿蒙副屏.app` 构建并安装，输出路径需尚未存在。应用使用专用的蓝色双屏 USB 图标，保留上游的 MIT 许可证。

更新本地签名版时，先按 `⌘Q` 退出「鸿蒙副屏」，再替换应用。若更新后 USB 已连接，切换画质却黑屏或停在旧画面，重新打开应用检查录屏权限。若应用提示缺少权限，但系统里的开关已经打开，请在「系统设置 → 隐私与安全 → 录屏与系统录音」中移除旧的「鸿蒙副屏」，重新添加「应用程序」里的新版，再按提示点「退出并重新打开」。

应用会自动选择屏幕用途。Mac 没有连接其他显示器时，平板作为主屏幕。有其他显示器时，原显示器保留主屏幕，平板显示独立的扩展桌面。运行中插拔显示器也会重新调整，当前模式会显示在应用窗口中。

主副屏判断以 macOS 实际识别到的显示器为准。通过 Windows 远程访问 Mac 时，远程软件显示它所选择的 Mac 桌面。

也可以使用源码中的启动脚本。

在 Mac 上准备 Python 3、Swift 构建工具和华为的 `hdc`。脚本会寻找 DevEco Studio 自带的 `hdc`，也可以通过 `SIDESCREEN_HDC` 指定可执行文件的完整路径。 [华为 hdc 使用说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hdc/)

1. 下载或克隆本仓库，在仓库目录运行 `./scripts/build_harmony_mac.sh`，构建带自动分辨率适配的 Mac 端。
2. 用 USB 数据线连接平板。在平板开启「USB 调试」，并允许这台 Mac 连接。
3. 如果原版 SideScreen 正在运行，先退出。双击仓库里的 [打开鸿蒙副屏.command](打开鸿蒙副屏.command)，保持终端窗口运行。首次使用时按 macOS 提示授权屏幕录制。
4. 解锁平板，等浏览器打开副屏页面，再点「全屏」。也可以在平板浏览器手动输入 `http://127.0.0.1:54323/`。收到画面后，「全屏」按钮下方会显示 `USB` 和实际串流分辨率。

在 Mac 的「系统设置 → 显示器」中调整屏幕排列，就可以把窗口拖到平板上。已用 Mac mini 和 HarmonyOS 7.0 平板验证 USB 出画。

如果插线后没有画面，检查 Mac 上的终端是否显示「USB 已连接」。没检测到设备时，用支持数据传输的线直插 Mac，并在解锁的平板上确认 USB 调试授权。可以临时关闭平板 Wi‑Fi，确认画面仍在更新。

想让鼠标和滚动更跟手时，在全屏前开启「低延迟」。它会降低视频分辨率，继续保持桌面的比例和 HiDPI 缩放。支持的浏览器会在独立线程中解码，并通过 OffscreenCanvas 直接提交画面。解码队列满时，播放器先处理已收到的帧，腾出位置后向 Mac 要一张完整画面，接着播放。若视频持续送达而画面停止刷新或明显跟不上，会自动切换到兼容播放方式，低延迟模式保持开启。再次点击可回到高清。

平板右上角的 **USB Ping** 和 **画面延迟** 用半透明底色显示，全屏时也会实时更新。USB Ping 优先采用浏览器网络层时间戳，测量浏览器到 Mac 的 USB 请求往返时间，并用同一组时间戳校准画面延迟。画面延迟估算从 Mac 开始编码到平板浏览器提交绘制的耗时，包含传输和解码。

排查卡顿时，可以在 Mac 访问 `http://127.0.0.1:54323/metrics`。`receivedFps` 是平板每秒收到的视频帧数，`drawnFps` 是实际提交绘制的帧数，`lastDrawAgeMs` 是距上一次绘制的毫秒数。页面也会上报请求往返、浏览器排队和解码耗时。这些数值只保存在 Mac 内存中。

### 验证情况

已在 Mac mini 和 HarmonyOS 7.0 平板上验证应用启动、USB 连接、2800×1840 画面及平板主屏模式。主屏、扩展副屏和移除另一块屏幕后恢复主屏的切换已用临时虚拟显示器验证，真实外接显示器的插拔仍待实测。

在同一台平板上模拟低延迟解码线程卡住后，播放器自行恢复了画面，全程保持 USB 连接。

通过鸿蒙系统的触控测试工具，在高清、低延迟和全屏画面上分别验证了轻点、双击、长按右键、滚动和拖动，并核对了 Mac 副屏窗口收到的坐标。

原有 Swift 单元测试套件需要 XCTest。当前本机的 Command Line Tools 环境缺少该模块，已完成应用编译、签名检查和上述运行验证。

---

<div align="center">
  <img src="resources/screenshots/hero_screenshot.jpeg" alt="Side Screen — Mac + Android tablet as second display" width="800"/>
</div>

---

## About the upstream Android client

Side Screen brings true second-display functionality to your Android tablet — over USB-C cable for the lowest latency, or wirelessly over WiFi after a one-time QR pair. Something macOS doesn't natively support either way.

While Apple's Sidecar only works with iPads, millions of Android tablets sit unused as potential workstations. Side Screen bridges that gap with hardware-accelerated H.265 streaming, sub-16ms pipeline latency on USB, and full touch input — making your tablet feel like a real monitor, not a laggy mirror.

Built entirely open-source, Side Screen is designed to be fast, lightweight, and seamlessly integrated.

For full details, features, and documentation, please visit **[sidescreen.dev](https://sidescreen.dev)**

<p align="right"><a href="#readme-top">↑ Back to top</a></p>

---

## Upstream features

### USB-C or Wireless

Two ways to connect, same picture quality. **USB-C** plugs in the cable for the lowest possible latency — adb-reverse port forwarding is set up automatically. **Wireless** lets you scan a QR code from the Mac once and the tablet auto-reconnects on every future launch over WiFi (5 GHz strongly recommended). The auth token is generated locally and stays on your Mac; reset it any time to revoke access.

### Virtual Display

Create a true virtual display on your Mac. Drag windows to your tablet like a real monitor — not mirroring, but extending.

<div align="center">
  <img src="resources/screenshots/feature_virtual_display.png" alt="Virtual Display in macOS Display Preferences" width="600"/>
</div>

### Ultra-Low Latency

Hardware-accelerated H.265 encoding on Mac and decoding on Android. Async pipeline architecture delivers frames in under 30ms.

<div align="center">
  <img src="resources/screenshots/android_performance.png" alt="Low Latency Streaming with Stats Overlay" width="700"/>
</div>

### Touch Support

Use your tablet's touchscreen to interact with macOS. Touch prediction compensates for network latency, making taps and drags feel natural.

### HiDPI (Retina) Support

Enable HiDPI mode to render at 2× resolution internally — text and icons are sharp at any logical resolution, just like a MacBook Retina display. Perfect for users with 2K/4K tablets who want a readable workspace without sacrificing sharpness.

### Gaming Mode

Enable Gaming Boost for optimized settings: 1 Gbps bitrate, ultra-low latency encoding, 120 FPS.

### Customizable

Configure resolution (up to 4K/8K), frame rate (30–120 FPS), bitrate (20–5000 Mbps), and quality presets from the Mac app.

<div align="center">
  <img src="resources/screenshots/mac_settings_1.png" alt="macOS Settings — Display & FPS" height="500"/>
  &nbsp;&nbsp;
  <img src="resources/screenshots/mac_settings_2.png" alt="macOS Settings — Streaming & Status" height="500"/>
  &nbsp;&nbsp;
  <img src="resources/screenshots/android_settings.png" alt="Android — Connection Screen" height="500"/>
</div>

### Headless / portable Mac (new in 0.11.0)

Run a Mac with no display of its own — a Mac Studio or Mini on the go, or a laptop in clamshell — using the tablet as its only screen. Enable Launch at Login and Auto-start streaming, and the Mac boots straight into serving the tablet, with nothing to press on the Mac.

<p align="right"><a href="#readme-top">↑ Back to top</a></p>

---

## Android requirements

| | macOS Host | Android Client |
|---|---|---|
| **OS** | macOS 13 (Ventura)+ | Android 8.0 (API 26)+ |
| **Hardware** | Apple Silicon or Intel | H.265 hardware decoder |
| **USB mode** | USB-C port + `adb` (`brew install android-platform-tools`) | USB-C cable + USB Debugging enabled |
| **Wireless mode** | Same WiFi network as the tablet (5 GHz recommended) | Camera (for QR scan) + Google Play Services (for ML Kit barcode) |

---

## Upstream installation

- **Android**: [Get it on Google Play](https://play.google.com/store/apps/details?id=com.sidescreen.app) — updates install automatically.
- **macOS**: Download the `.dmg` from [**GitHub Releases**](https://github.com/tranvuongquocdat/SideScreen/releases), open it, drag Side Screen to Applications. The app is signed and notarized by Apple, and checks for updates on its own. Port forwarding over USB is handled automatically by the Mac app.

> **⚠️ ADB Required**
> The Mac app needs `adb` to communicate with your Android device. If the app doesn't show "Running" after launch, you likely need to install ADB:
>
> 1. Install Homebrew (if you don't have it):
>    ```bash
>    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
>    ```
> 2. Install ADB:
>    ```bash
>    brew install --cask android-platform-tools
>    ```

<details>
<summary><strong>Build from source (for developers)</strong></summary>

```bash
git clone https://github.com/tranvuongquocdat/SideScreen.git
cd SideScreen

# macOS
cd MacHost && swift build -c release

# Android
cd AndroidClient && ./gradlew assembleDebug
```
</details>

---

## Usage

### Android USB mode (default — lowest latency)

1. Connect tablet to Mac via **USB-C**
2. Launch **Side Screen** on Mac (runs in menu bar — port forwarding is set up automatically)
3. Open **Side Screen** on tablet → keep on the **USB** tab → tap **Connect**
4. Done — drag windows to your new display

### Android wireless mode (new in 0.8.0 — no cable)

1. Launch **Side Screen** on Mac → toggle to the **Wireless** tab → a QR code appears
2. Open **Side Screen** on tablet → switch to the **Wireless** tab → tap **Scan QR Code** → grant camera permission → aim at the QR on the Mac
3. The tablet remembers the Mac. Subsequent launches auto-reconnect — no rescan.

Wireless mode requires both devices to be on the same WiFi network. **5 GHz is strongly recommended** — 2.4 GHz can introduce noticeable jitter on dynamic content. If you need to revoke access, click **Reset Token (forget all)** on the Mac and re-pair each tablet.

USB mode remains the lowest-latency option for drawing or fast-paced gaming. Wireless adds 10–50 ms depending on WiFi quality.

### Headless mode (new in 0.11.0 — no Mac interaction)

In Settings → Startup, turn on **Launch at Login** and **Auto-start streaming on launch**, then pick the **Startup mode** (USB or Wireless). On your next login the server starts automatically — just open Side Screen on the tablet and tap Connect (USB) or Reconnect (Wireless).

First-time setup still needs a screen once to grant Screen Recording permission; after that the Mac runs fully headless. For wireless headless use, give the Mac a static IP or DHCP reservation, and consider enabling macOS Screen Sharing as a fallback way in.

---

## Configuration

| Setting | Options | Default |
|---------|---------|---------|
| Resolution | 720p to 8K, 30+ presets + custom | 1920x1200 |
| Frame Rate | 30, 60, 90, 120 FPS | 120 |
| Bitrate | 20–5000 Mbps | 1000 Mbps |
| Quality | Ultra Low, Low, Medium, High | Ultra Low |
| HiDPI (Retina) | On/Off | Off |
| Gaming Boost | On/Off (1 Gbps, 120 Hz) | Off |
| Touch Input | On/Off | On |

---

## Troubleshooting

<details>
<summary><strong>"SideScreen is damaged" on macOS</strong></summary>

Versions before 1.1.0 were not notarized. Update to the latest release from [GitHub Releases](https://github.com/tranvuongquocdat/SideScreen/releases), which opens without any workaround. If you must keep an old version, run `sudo xattr -cr /Applications/SideScreen.app` once.
</details>

<details>
<summary><strong>"Connection refused" on Android</strong></summary>

The Mac app sets up `adb reverse` automatically when streaming starts. If it still fails, make sure `adb` is installed (via Android SDK or Homebrew: `brew install android-platform-tools`) and your device has USB debugging enabled.
</details>

<details>
<summary><strong>High latency or stuttering</strong></summary>

- Lower resolution or frame rate
- Ensure H.265 hardware codec support on your device
- For USB mode, use a high-quality USB-C cable (not charge-only)
- For wireless mode, ensure both devices are on **5 GHz WiFi**, not 2.4 GHz; reduce refresh rate to 60 Hz if jitter persists
</details>

<details>
<summary><strong>Wireless: "Couldn't reach Mac" / connection times out</strong></summary>

- Both devices must be on the same WiFi network (and same subnet — some mesh routers isolate "guest" devices)
- Click **Start** on the Mac before scanning the QR — the listener only binds when the server is running
- If the Mac changes WiFi or its LAN IP, scan a fresh QR (the cached one points to the old address)
- macOS may prompt for **Local Network** permission on first wireless toggle — grant it; without it, LAN inbound is silently dropped
</details>

<details>
<summary><strong>Wireless: "Re-pair required" after restart / reinstall</strong></summary>

The Mac's auth token resets when you click **Reset Token (forget all)** or reinstall the app. Tap **Scan QR Code** on the Android client and scan the new QR shown on the Mac.
</details>

<details>
<summary><strong>Tablet goes black whenever an app is fullscreen on the Mac</strong></summary>

This is macOS, not the stream: with **"Displays have separate Spaces"** turned off, macOS blanks every other display — including the virtual one the tablet shows — as soon as any app enters fullscreen. Turn it on in **System Settings → Desktop & Dock → Mission Control → Displays have separate Spaces**, then log out and back in. The Mac app shows a warning in its Status panel when this setting is off.
</details>

<details>
<summary><strong>Virtual display not appearing</strong></summary>

Grant Screen Recording permission: **System Preferences → Privacy & Security → Screen Recording → Enable Side Screen**
</details>

---

## Contributing

Contributions are welcome!

- ⭐ **Star** this repo to help others discover it
- 🐛 **Report bugs** via [Issues](https://github.com/tranvuongquocdat/SideScreen/issues)
- 💡 **Suggest features** via [Issues](https://github.com/tranvuongquocdat/SideScreen/issues)
- 🔧 **Submit PRs** — see [CONTRIBUTING.md](CONTRIBUTING.md)

---

## Support

If Side Screen is useful to you, consider supporting development:

<div align="center">

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/tranvuongqk)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/tranvuongquocdat)
[![VietQR](https://img.shields.io/badge/Vietnam-VietQR-DA251D?style=for-the-badge&logoColor=white)](https://sidescreen.dev/donate.html)

</div>

🇻🇳 Vietnamese users — scan VietQR for a local bank transfer (no international fees) at [sidescreen.dev/donate](https://sidescreen.dev/donate.html).

---

## License

[MIT License](LICENSE) — free for personal and commercial use.

---

<div align="center">

Made with ❤️ by **Tran Vuong Quoc Dat**

[Report Bug](https://github.com/tranvuongquocdat/SideScreen/issues) · [Request Feature](https://github.com/tranvuongquocdat/SideScreen/issues) · [Discussions](https://github.com/tranvuongquocdat/SideScreen/discussions)

</div>
