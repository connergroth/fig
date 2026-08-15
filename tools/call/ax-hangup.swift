// ax-hangup — end the current FaceTime call via the accessibility API.
//
// Same native AX machinery as ax-answer (no System Events — that layer is hung on
// this machine). Strict match, mirroring the ax-answer v2 lesson: only a real
// end/leave/hang-up CONTROL, never long banner body text (pressing a banner body
// dismisses it without acting).
//
// Search order:
//   1. FaceTime app windows (the in-call window carries the End/Leave button)
//   2. NotificationCenter banners that are actually about a call
//
// Exit codes: 0 = pressed something, 2 = no end control found (caller decides the
// fallback — e.g. terminating FaceTime outright, which reliably ends the call).
//
// usage: ax-hangup [timeoutSecs=5]
import Cocoa
import ApplicationServices

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
    return "role=\(role) title='\(title)' desc='\(desc.prefix(80))' id='\(id)'"
}
func subtreeText(_ el: AXUIElement, depth: Int = 0) -> String {
    if depth > 8 { return "" }
    var out = attr(el, kAXTitleAttribute as String) + " " + attr(el, kAXDescriptionAttribute as String)
        + " " + attr(el, kAXValueAttribute as String)
    for c in children(el) { out += " " + subtreeText(c, depth: depth + 1) }
    return out
}

// STRICT: a named end/leave action, or an AXButton whose SHORT title/desc/id is
// end-call-ish. "leave" is what modern FaceTime labels the 1:1 end control.
let endish = ["end", "leave", "hang up", "hangup", "end call", "leave call"]
func shortMatches(_ s: String) -> Bool {
    let t = s.lowercased().trimmingCharacters(in: .whitespaces)
    if t.count >= 60 { return false }
    return endish.contains(where: { t == $0 || t.contains($0) })
        // guard: "end-to-end", "friend", "calendar" style false hits
        && !t.contains("friend") && !t.contains("end-to-end") && !t.contains("extend")
}
func findAndPressEnd(_ el: AXUIElement, depth: Int) -> Bool {
    if depth > 12 { return false }
    for a in actions(el) {
        let al = a.lowercased()
        if al.contains("end call") || al.contains("hang up") || al.contains("leave call") {
            let r = AXUIElementPerformAction(el, a as CFString)
            print(">>> PERFORMED \(a) on: \(describe(el)) result=\(r.rawValue)")
            return true
        }
    }
    if attr(el, kAXRoleAttribute as String) == "AXButton" {
        let short = attr(el, kAXTitleAttribute as String) + " "
            + attr(el, kAXDescriptionAttribute as String) + " " + attr(el, "AXIdentifier")
        if shortMatches(short) {
            let r = AXUIElementPerformAction(el, "AXPress" as CFString)
            print(">>> PRESSED button: \(describe(el)) result=\(r.rawValue)")
            return true
        }
    }
    for c in children(el) {
        if findAndPressEnd(c, depth: depth + 1) { return true }
    }
    return false
}

func appElement(_ bundleID: String) -> AXUIElement? {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { return nil }
    return AXUIElementCreateApplication(app.processIdentifier)
}

let timeout = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 5.0) : 5.0
let deadline = Date().addingTimeInterval(timeout)

while Date() < deadline {
    // 1) FaceTime windows — the in-call UI owns the End/Leave control
    if let ft = appElement("com.apple.FaceTime") {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(ft, kAXWindowsAttribute as CFString, &v) == .success,
           let wins = v as? [AXUIElement] {
            for w in wins where findAndPressEnd(w, depth: 0) { exit(0) }
        }
    }
    // 2) NotificationCenter banners actually about a call
    if let nc = appElement("com.apple.notificationcenterui") {
        for w in children(nc) {
            let text = subtreeText(w).lowercased()
            let isCall = text.contains("facetime") || text.contains("audio call") || text.contains("call")
            if isCall, findAndPressEnd(w, depth: 0) { exit(0) }
        }
    }
    usleep(300_000)
}
print("no end/leave control found within \(timeout)s")
exit(2)
