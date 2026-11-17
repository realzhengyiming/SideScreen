import Cocoa
import Combine
import Darwin

/// Owns the bundled USB bridge for the lifetime of the Mac application.
final class HarmonyBridgeController: ObservableObject {
    static var isApp: Bool {
        Bundle.main.object(forInfoDictionaryKey: "SideScreenHarmonyUSB") as? Bool == true
            && !ProcessInfo.processInfo.arguments.contains("--harmony-usb")
    }

    @Published private(set) var message = "正在连接鸿蒙平板…"
    @Published private(set) var usbConnected = false
    @Published private(set) var isRunning = false
    @Published private(set) var isStopping = false

    private struct Status: Decodable {
        let connected: Bool
        let message: String
    }

    private var process: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private var outputBuffer = Data()
    private var errorOutput = ""
    private var stopCompletions: [() -> Void] = []

    func start(port: UInt16) {
        guard process == nil else { return }
        guard let resources = Bundle.main.resourceURL else { return }
        let script = resources.appendingPathComponent("HarmonyClient/bridge.py")
        let hdc = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/HarmonyOS/hdc")
        guard FileManager.default.fileExists(atPath: script.path),
              FileManager.default.isExecutableFile(atPath: hdc.path) else {
            message = "应用缺少 USB 连接组件，请重新安装鸿蒙副屏。"
            return
        }
        let pythonPaths = ["/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python3"]
        guard let python = pythonPaths.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            message = "未找到 Python 3，请安装 Python 3 后重新连接。"
            return
        }

        let child = Process()
        let output = Pipe()
        let errors = Pipe()
        child.executableURL = URL(fileURLWithPath: python)
        child.arguments = [
            "-I", "-B", "-u", script.path, "--no-start-mac", "--status-json",
            "--mac-port", String(port), "--parent-pid", String(getpid())
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["SIDESCREEN_HDC"] = hdc.path
        child.environment = environment
        child.standardOutput = output
        child.standardError = errors
        child.standardInput = FileHandle.nullDevice
        outputBuffer.removeAll()
        errorOutput = ""
        message = "正在连接鸿蒙平板…"
        process = child
        outputPipe = output
        errorPipe = errors

        output.fileHandleForReading.readabilityHandler = { [weak self, weak child] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self, let child, self.process === child else { return }
                self.receive(data)
            }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self, weak child] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self, let child, self.process === child else { return }
                self.errorOutput = String((self.errorOutput + String(decoding: data, as: UTF8.self)).suffix(2048))
                debugLog("Harmony USB: \(String(decoding: data, as: UTF8.self))")
            }
        }
        child.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self, self.process === child else { return }
                self.finish(status: child.terminationStatus)
            }
        }
        do {
            try child.run()
            isRunning = true
        } catch {
            message = "无法启动 USB 连接服务。\(error.localizedDescription)"
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            process = nil
            outputPipe = nil
            errorPipe = nil
        }
    }

    private func receive(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = Data(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            if let status = try? JSONDecoder().decode(Status.self, from: line) {
                usbConnected = status.connected
                message = status.message
            } else {
                debugLog("Harmony USB: \(String(decoding: line, as: UTF8.self))")
            }
        }
    }

    func reopenViewer() {
        guard let process, process.isRunning, usbConnected, !isStopping else { return }
        kill(process.processIdentifier, SIGUSR1)
    }

    func reconnect(port: UInt16) {
        stop { [weak self] in self?.start(port: port) }
    }

    func stop(completion: (() -> Void)? = nil) {
        if let completion { stopCompletions.append(completion) }
        guard let child = process else {
            completeStop()
            return
        }
        guard !isStopping else { return }
        isStopping = true
        if child.isRunning { child.terminate() }
        // The bridge normally removes its USB forwarding rule before exiting.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self, weak child] in
            guard let self, let child, self.process === child, child.isRunning else { return }
            kill(child.processIdentifier, SIGKILL)
        }
    }

    private func finish(status: Int32) {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        process = nil
        outputPipe = nil
        errorPipe = nil
        isRunning = false
        usbConnected = false
        if isStopping {
            message = "已停止连接"
        } else {
            let detail = errorOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            message = detail.isEmpty ? "USB 连接服务已退出（\(status)），请点击重新连接。" : detail
        }
        isStopping = false
        completeStop()
    }

    private func completeStop() {
        let completions = stopCompletions
        stopCompletions.removeAll()
        completions.forEach { $0() }
    }
}
