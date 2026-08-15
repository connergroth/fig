import Cocoa
import ApplicationServices

func ts() -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f.string(from: Date())
}
func log(_ s: String) {
    let line = "\(ts()) \(s)\n"
    if let d = line.data(using: .utf8), let h = FileHandle(forWritingAtPath: logPath) {
        h.seekToEndOfFile(); h.write(d); h.closeFile()
    }
    print(line, terminator: "")
}
let logDir = NSString(string: "~/scratch/fig-call").expandingTildeInPath
let logPath = (logDir as NSString).appendingPathComponent("ax-answer.log")
try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
FileManager.default.createFile(atPath: logPath, contents: nil)

func attr(_ el: AXUIElement, _ name: String) -> String {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let s = v as? String { return s }
    return ""
}
func children(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success,
       let arr = v as? [AXUIElement] { return arr }
    return []
}
func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    if AXUIElementCopyActionNames(el, &names) == .success, let a = names as? [String] { return a }
    return []
}
func describe(_ el: AXUIElement) -> String {
    let role = attr(el, kAXRoleAttribute as String)
    let title = attr(el, kAXTitleAttribute as String)
    let desc = attr(el, kAXDescriptionAttribute as String)
    let id = attr(el, "AXIdentifier")
    let acts = actions(el).joined(separator: ",")
    return "role=\(role) title='\(title)' desc='\(desc.prefix(120))' id='\(id)' actions=[\(acts)]"
}

// Cycle guard. The Notification Center AX tree is SELF-REFERENTIAL: its AXApplication
// element reappears as its own descendant several levels down. A plain depth-capped walk
// therefore doesn't finish in any useful time — it re-expands the whole app on every
// branch, so a depth-8 text pass is ~5^8 AX round trips and a depth-12 press scan is
// ~5^12. That is how a resident watcher looks alive (process up, no errors) while taking
// TEN MINUTES between polls and never pressing anything inside a 30s ring. Dedupe by
// element identity and hard-cap node budget so one poll is bounded work.
final class Walk {
    var seen = Set<Int>()
    var budget: Int
    init(_ budget: Int) { self.budget = budget }
    // CFHash is stable per element; a collision only costs one skipped node.
    func enter(_ el: AXUIElement) -> Bool {
        if budget <= 0 { return false }
        budget -= 1
        return seen.insert(Int(bitPattern: CFHash(el))).inserted
    }
}

// concat all text in a subtree (bounded depth, cycle-safe)
func subtreeText(_ el: AXUIElement, _ w: Walk, depth: Int = 0) -> String {
    if depth > 8 || !w.enter(el) { return "" }
    var out = attr(el, kAXTitleAttribute as String) + " " + attr(el, kAXDescriptionAttribute as String)
        + " " + attr(el, kAXValueAttribute as String)
    for c in children(el) { out += " " + subtreeText(c, w, depth: depth + 1) }
    return out
}

// STRICT press: only a real accept/answer control.
// - an action NAMED accept/answer (the banner exposes "Name:Answer"), or
// - an AXButton whose SHORT title/desc/id is accept/answer-ish.
// Never matches on long notification body text — that's the bug that ate the 12:51 run.
func findAndPressAnswer(_ el: AXUIElement, depth: Int, _ w: Walk) -> Bool {
    if depth > 12 || !w.enter(el) { return false }
    let acts = actions(el)
    for a in acts {
        let al = a.lowercased()
        if al.contains("accept") || al.contains("answer") {
            let r = AXUIElementPerformAction(el, a as CFString)
            log(">>> PERFORMED \(a) on: \(describe(el)) result=\(r.rawValue)")
            return true
        }
    }
    let role = attr(el, kAXRoleAttribute as String)
    if role == "AXButton" {
        let short = (attr(el, kAXTitleAttribute as String) + " "
            + attr(el, kAXDescriptionAttribute as String) + " "
            + attr(el, "AXIdentifier")).lowercased()
        if short.count < 60, short.contains("accept") || short.contains("answer") {
            let r = AXUIElementPerformAction(el, "AXPress" as CFString)
            log(">>> PRESSED button: \(describe(el)) result=\(r.rawValue)")
            return true
        }
    }
    for c in children(el) {
        if findAndPressAnswer(c, depth: depth + 1, w) { return true }
    }
    return false
}

func appElement(_ bundleID: String) -> AXUIElement? {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { return nil }
    return AXUIElementCreateApplication(app.processIdentifier)
}

// window is now an optional CLI arg (minutes), default 15
let windowMins = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 15.0) : 15.0
log("=== ax-answer watcher v3 start (\(Int(windowMins)) min window, strict match, stays up after press) ===")
// AX trust is the silent killer: untrusted, every children() call returns [] and the
// watcher looks perfectly healthy while being structurally blind. Say it out loud at boot.
log("AXIsProcessTrusted=\(AXIsProcessTrusted())")
let deadline = Date().addingTimeInterval(windowMins * 60)
var lastPress = Date.distantPast
var loggedBanners = Set<String>()

// Banners are WINDOWS of the NC app, not arbitrary children. Asking for AXWindows skips
// the self-referential application spine entirely, which is where the blowup lived.
func topLevel(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXWindowsAttribute as CFString, &v) == .success,
       let wins = v as? [AXUIElement], !wins.isEmpty { return wins }
    return children(el)
}

var lastHeartbeat = Date.distantPast
var slowPolls = 0
var lastNCWindowCount = -1
var lastFTWindowCount = -1

while Date() < deadline {
    let pollStart = Date()
    // cooldown after a press so we don't double-fire on the same banner
    if pollStart.timeIntervalSince(lastPress) > 5 {
        var pressedThisLoop = false
        // 1) NotificationCenter banners — only ones that are actually about a call
        if let nc = appElement("com.apple.notificationcenterui") {
            let wins = topLevel(nc)
            // A ring with zero NC windows means the banner never rendered — a different
            // failure than "banner rendered, no Answer control". Log the transition so the
            // two are distinguishable after the fact instead of both looking like silence.
            if wins.count != lastNCWindowCount {
                lastNCWindowCount = wins.count
                log("NC window count -> \(wins.count)")
            }
            for w in wins {
                let text = subtreeText(w, Walk(4000)).lowercased()
                let isCall = text.contains("facetime") || text.contains("audio call") || text.contains("incoming call")
                let key = String(text.prefix(80))
                if !loggedBanners.contains(key) {
                    loggedBanners.insert(key)
                    log("NC banner seen (call=\(isCall)): \(key)")
                }
                if isCall, findAndPressAnswer(w, depth: 0, Walk(8000)) {
                    lastPress = Date(); pressedThisLoop = true
                    log("answer fired via NC banner — staying up, still watching")
                    break
                }
            }
        }
        // 2) FaceTime app windows (in-app incoming call UI)
        if !pressedThisLoop, let ft = appElement("com.apple.FaceTime") {
            let ftWins = topLevel(ft)
            if ftWins.count != lastFTWindowCount {
                lastFTWindowCount = ftWins.count
                log("FaceTime window count -> \(ftWins.count): "
                    + ftWins.map { subtreeText($0, Walk(1500)).prefix(120) }.joined(separator: " | "))
            }
            for w in ftWins {
                if findAndPressAnswer(w, depth: 0, Walk(8000)) {
                    lastPress = Date()
                    log("answer fired via FaceTime window — staying up, still watching")
                    break
                }
            }
        }
    }
    // A poll must stay cheap. If it doesn't, say so in the log rather than going quiet:
    // silence from this watcher is otherwise indistinguishable from "nothing was ringing".
    let took = Date().timeIntervalSince(pollStart)
    if took > 2 {
        slowPolls += 1
        if slowPolls <= 5 || slowPolls % 20 == 0 {
            log("WARN slow poll: \(String(format: "%.1f", took))s (#\(slowPolls))")
        }
    }
    if Date().timeIntervalSince(lastHeartbeat) > 300 {
        lastHeartbeat = Date()
        log("alive — polling (last poll \(String(format: "%.2f", took))s, slow polls: \(slowPolls))")
    }
    usleep(300_000)
}
log("=== ax-answer watcher end (window expired) ===")
