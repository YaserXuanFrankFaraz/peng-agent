import AppKit
import Darwin
import Foundation
import WebKit

final class RuntimePaths {
    let appRoot: URL
    let serverDirectory: URL
    let dataDirectory: URL
    let logDirectory: URL
    let pidFile: URL
    let urlFile: URL
    let logFile: URL

    init() {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let fallbackRoot = executable
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let bundleRoot = Bundle.main.bundleURL
        appRoot = bundleRoot.path == "/" ? fallbackRoot : bundleRoot
        serverDirectory = appRoot.appendingPathComponent("Contents/Resources/server")

        let environment = ProcessInfo.processInfo.environment
        if let value = environment["PENG_DATA_DIR"], !value.isEmpty {
            dataDirectory = URL(fileURLWithPath: value)
        } else {
            dataDirectory = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Peng")
        }
        logDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Peng")
        pidFile = dataDirectory.appendingPathComponent("server.pid")
        urlFile = dataDirectory.appendingPathComponent("server.url")
        logFile = logDirectory.appendingPathComponent("server.log")
    }

    var workspace: String {
        let value = ProcessInfo.processInfo.environment["PENG_WORKSPACE"] ?? ""
        return value.isEmpty ? FileManager.default.homeDirectoryForCurrentUser.path : value
    }

    var host: String {
        let value = ProcessInfo.processInfo.environment["PENG_HOST"] ?? ""
        return value.isEmpty ? "127.0.0.1" : value
    }

    var port: String {
        let value = ProcessInfo.processInfo.environment["PENG_PORT"] ?? ""
        return value.isEmpty ? "0" : value
    }

    func storedURL() -> String? {
        guard let value = try? String(contentsOf: urlFile, encoding: .utf8) else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func storedPID() -> Int32? {
        guard let value = try? String(contentsOf: pidFile, encoding: .utf8),
              let pid = Int32(value.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return pid
    }

    func isRunning(_ pid: Int32) -> Bool {
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    func clearState() {
        try? FileManager.default.removeItem(at: pidFile)
        try? FileManager.default.removeItem(at: urlFile)
    }
}

func runControlCommand(_ arguments: [String]) -> Bool {
    guard let command = arguments.first else { return false }
    let paths = RuntimePaths()

    if command == "--manifest" {
        print("{\"name\":\"peng-app\",\"runtime\":\"native-wkwebview\",\"server\":\"craft-server\"}")
        exit(0)
    }
    if command == "--help" || command == "-h" {
        print("Peng macOS application\n\nUsage: double-click Peng.app to open the native window.\n       Peng --status | --stop")
        exit(0)
    }
    if command == "--status" {
        if let pid = paths.storedPID(), paths.isRunning(pid), let url = paths.storedURL() {
            print("Peng is running at \(url)")
        } else {
            print("Peng is not running.")
        }
        exit(0)
    }
    if command == "--stop" {
        if let pid = paths.storedPID(), paths.isRunning(pid) {
            _ = kill(pid, SIGTERM)
            for _ in 0..<20 {
                if !paths.isRunning(pid) { break }
                usleep(100_000)
            }
            print("Peng server stopped.")
        } else {
            print("Peng server is not running.")
        }
        paths.clearState()
        exit(0)
    }
    return false
}

final class PengAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private let paths = RuntimePaths()
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private var serverLogHandle: FileHandle?
    private var startedServer = false
    private var pollTimer: Timer?
    private var isTerminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        createWindow()
        if let url = paths.storedURL(), let pid = paths.storedPID(), paths.isRunning(pid) {
            load(url: url)
        } else {
            paths.clearState()
            startServer()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isTerminating = true
        stopServerIfOwned()
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        stopServerIfOwned()
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.loadHTMLString(loadingHTML(), baseURL: nil)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Peng"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.center()
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startServer() {
        do {
            try FileManager.default.createDirectory(at: paths.dataDirectory, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: paths.logDirectory, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: paths.logFile.path, contents: nil)
            serverLogHandle = try FileHandle(forWritingTo: paths.logFile)
            serverLogHandle?.seekToEndOfFile()

            let process = Process()
            let craftBinary = paths.serverDirectory.appendingPathComponent("craft-server")
            let bunBinary = paths.serverDirectory.appendingPathComponent("bun")
            let nodeBinary = paths.serverDirectory.appendingPathComponent("node")
            let entrypoint = paths.serverDirectory.appendingPathComponent("bin/craft-server.mjs")
            let serverArguments = ["--host", paths.host, "--port", paths.port, "--workspace", paths.workspace, "--json"]

            if FileManager.default.isExecutableFile(atPath: craftBinary.path) {
                process.executableURL = craftBinary
                process.arguments = serverArguments
            } else if FileManager.default.isExecutableFile(atPath: bunBinary.path) {
                process.executableURL = bunBinary
                process.arguments = [entrypoint.path] + serverArguments
            } else if FileManager.default.isExecutableFile(atPath: nodeBinary.path) {
                process.executableURL = nodeBinary
                process.arguments = [entrypoint.path] + serverArguments
            } else {
                showError("Peng 的内置 JavaScript 运行时不存在。")
                return
            }
            process.currentDirectoryURL = paths.serverDirectory
            process.standardOutput = serverLogHandle
            process.standardError = serverLogHandle
            process.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, !self.isTerminating else { return }
                    self.showError("Peng 服务已停止，请查看日志：\n\(self.paths.logFile.path)")
                }
            }
            try process.run()
            serverProcess = process
            startedServer = true
            try String(process.processIdentifier).write(to: paths.pidFile, atomically: true, encoding: .utf8)
            waitForServerURL()
        } catch {
            showError("Peng 启动失败：\n\(error.localizedDescription)")
        }
    }

    private func waitForServerURL() {
        var attempts = 0
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            attempts += 1
            if let url = self.urlFromLog() {
                timer.invalidate()
                self.load(url: url)
            } else if attempts >= 150 {
                timer.invalidate()
                self.showError("Peng 服务启动超时，请查看日志：\n\(self.paths.logFile.path)")
            } else if let process = self.serverProcess, !process.isRunning {
                timer.invalidate()
                self.showError("Peng 服务启动失败，请查看日志：\n\(self.paths.logFile.path)")
            }
        }
    }

    private func urlFromLog() -> String? {
        guard let value = try? String(contentsOf: paths.logFile, encoding: .utf8) else { return nil }
        for line in value.split(separator: "\n").reversed() {
            guard let data = String(line).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let url = object["url"] as? String,
                  URL(string: url) != nil else { continue }
            try? url.write(to: paths.urlFile, atomically: true, encoding: .utf8)
            return url
        }
        return nil
    }

    private func load(url: String) {
        guard let target = URL(string: url) else {
            showError("Peng 服务地址无效：\n\(url)")
            return
        }
        pollTimer?.invalidate()
        webView.load(URLRequest(url: target))
    }

    private func stopServerIfOwned() {
        pollTimer?.invalidate()
        serverLogHandle?.closeFile()
        serverLogHandle = nil
        guard startedServer, let process = serverProcess, process.isRunning else { return }
        process.terminate()
        serverProcess = nil
        paths.clearState()
    }

    private func loadingHTML() -> String {
        """
        <!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width\"><style>
        html,body{height:100%;margin:0;background:#0b0d12;color:#e8ecf5;font:15px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center}
        main{text-align:center} .spinner{width:22px;height:22px;border:2px solid #485064;border-top-color:#71d7ff;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}
        @keyframes spin{to{transform:rotate(360deg)}}
        </style></head><body><main><div class=spinner></div><div>正在启动 Peng…</div></main></body></html>
        """
    }

    private func showError(_ message: String) {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\n", with: "<br>")
        webView.loadHTMLString("<html><body style=\"font:15px -apple-system;padding:48px;background:#0b0d12;color:#e8ecf5\"><h2>Peng</h2><p>\(escaped)</p></body></html>", baseURL: nil)
    }
}

if !runControlCommand(Array(CommandLine.arguments.dropFirst())) {
    let application = NSApplication.shared
    let delegate = PengAppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}
