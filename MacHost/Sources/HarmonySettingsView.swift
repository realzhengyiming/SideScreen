import Cocoa
import SwiftUI

struct HarmonySettingsView: View {
    @ObservedObject var settings: DisplaySettings
    @ObservedObject var bridge: HarmonyBridgeController
    let reconnect: () -> Void

    private var status: String {
        if !settings.hasScreenRecordingPermission { return "需要开启屏幕录制权限" }
        if settings.clientConnected { return "副屏已连接" }
        if !bridge.isRunning { return "连接服务已停止" }
        return bridge.usbConnected ? "等待平板打开画面" : "等待连接平板"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 60, height: 60)
                VStack(alignment: .leading, spacing: 4) {
                    Text("鸿蒙副屏").font(.title2.weight(.semibold))
                    Text("通过 USB 扩展 Mac 桌面")
                        .foregroundColor(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Label(status, systemImage: settings.clientConnected ? "checkmark.circle.fill" : "cable.connector")
                    .font(.headline)
                    .foregroundColor(settings.clientConnected ? .green : .primary)
                Text(bridge.message)
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))

            if !settings.hasScreenRecordingPermission {
                Button("打开屏幕录制设置") {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
                }
                .buttonStyle(.borderedProminent)
            }

            VStack(spacing: 8) {
                if let role = settings.displayRole {
                    LabeledContent("当前模式", value: role.rawValue)
                }
                if let mode = settings.tabletDisplayMode {
                    LabeledContent("平板分辨率", value: "\(mode.width) × \(mode.height) · 60 Hz")
                }
                Toggle("平板触控", isOn: $settings.touchEnabled)
                    .toggleStyle(.switch)
                if settings.touchEnabled && !settings.hasAccessibilityPermission {
                    HStack {
                        Text("允许辅助功能后，平板可点击和拖动 Mac 窗口。")
                            .font(.caption).foregroundColor(.secondary)
                        Spacer()
                        Button("打开辅助功能设置") {
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("平板浏览器地址").foregroundColor(.secondary)
                Text("http://127.0.0.1:54323/")
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                Text("连接数据线并解锁平板后，浏览器会自动打开。")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer(minLength: 0)
            HStack {
                Button("重新连接", action: reconnect)
                    .disabled(bridge.isStopping)
                Button("打开平板页面") { bridge.reopenViewer() }
                    .disabled(!bridge.usbConnected || bridge.isStopping)
                Spacer()
                Button("显示器排列") {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.displays")!)
                }
            }
        }
        .padding(26)
        .frame(width: 470, height: 495)
    }
}

extension SettingsWindowController {
    convenience init(settings: DisplaySettings, bridge: HarmonyBridgeController, reconnect: @escaping () -> Void) {
        let window = ConstrainedWindow(
            contentRect: NSRect(x: 0, y: 0, width: 470, height: 495),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "鸿蒙副屏"
        window.titlebarAppearsTransparent = true
        window.center()
        window.contentView = NSHostingView(rootView: HarmonySettingsView(settings: settings, bridge: bridge, reconnect: reconnect))
        window.isReleasedWhenClosed = false
        self.init(window: window)
        window.delegate = self
    }
}
