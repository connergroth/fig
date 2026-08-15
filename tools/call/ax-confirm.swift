// ax-confirm — press the "Call" button on FaceTime's outbound "Click to Call"
// Notification Center banner. Strict: only an AXButton whose desc/title is
// exactly call-ish, only inside a FACETIME_NOTIFICATION group.
// usage: ax-confirm [timeoutSecs=15] [button=call]  (button: call | cancel)
import Cocoa
import ApplicationServices

func attr(_ el: AXUIElement, _ name: String) -> String {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
    }
    return ""
}
func children(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success,
       let arr = v as? [AXUIElement] { return arr }
    return []
}

// collect all text under an element (to verify the banner is the facetime one)
func allText(_ el: AXUIElement, _ depth: Int = 0) -> String {
    if depth > 8 { return "" }
    var out = attr(el, kAXTitleAttribute as String) + " " + attr(el, kAXDescriptionAttribute as String) + " " + attr(el, "AXIdentifier")
    for c in children(el) { out += " " + allText(c, depth + 1) }
    return out
}

// find a Call button inside a facetime notification group
func findCallButton(_ el: AXUIElement, inFT: Bool, _ depth: Int = 0) -> AXUIElement? {
    if depth > 12 { return nil }
    let id = attr(el, "AXIdentifier").lowercased()
    let nowFT = inFT || id.contains("facetime_notification")
    if nowFT {
        let role = attr(el, kAXRoleAttribute as String)
        let desc = attr(el, kAXDescriptionAttribute as String).lowercased()
        let title = attr(el, kAXTitleAttribute as String).lowercased()
        if role == "AXButton", desc == wantedButton || title == wantedButton { return el }
    }
    for c in children(el) {
        if let hit = findCallButton(c, inFT: nowFT, depth + 1) { return hit }
    }
    return nil
}

let timeout = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 15 : 15
let wantedButton = CommandLine.arguments.count > 2 ? CommandLine.arguments[2].lowercased() : "call"
let deadline = Date().addingTimeInterval(timeout)

guard let nc = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.notificationcenterui" }) else {
    print("no notification center process"); exit(1)
}
let ncEl = AXUIElementCreateApplication(nc.processIdentifier)

while Date() < deadline {
    if let btn = findCallButton(ncEl, inFT: false) {
        let err = AXUIElementPerformAction(btn, kAXPressAction as CFString)
        print("PRESSED \(wantedButton) button, result=\(err.rawValue)")
        exit(err == .success ? 0 : 2)
    }
    usleep(300_000)
}
print("timeout: no facetime Call banner found in \(Int(timeout))s")
exit(3)
