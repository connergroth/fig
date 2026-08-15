// injectin — the MOUTH: read raw PCM16 LE MONO 24000 Hz from STDIN and play
// it continuously into a named output device (ALWAYS BlackHoleInject2ch_UID —
// the patched driver surfaces B's output on BlackHole 2ch's mic stream while
// keeping the AEC echo-reference ring silent — this is what makes us audible).
//
// Stream-oriented, with the device pinned rather than chosen by default:
//   - AVAudioSourceNode pulls from a FIFO; upsampling 24k mono -> device
//     format is done by the engine's connection converter
//   - underrun = silence (never glitches, never blocks)
//   - SIGUSR1 = FLUSH: drop everything buffered immediately (barge-in)
//   - stdin EOF + FIFO drained = clean exit
//
// Stall self-heal: FaceTime's audio
// spin-up on the shared patched driver right at connect can stop this engine's
// render callbacks cold — rendered froze at ~0.85s while the engine still claimed
// running, so the whole call was silent. Starting the engine ~1s later dodges the
// window by luck, which is not a fix. Two defenses:
//   - AVAudioEngineConfigurationChange -> re-pin the Inject device + restart
//   - render watchdog: rendered frozen >2s -> loud MOUTH-STALL + one restart per
//     stall; if the restart doesn't unfreeze it, exit(1) so the session dies
//     LOUDLY ("injectin died") instead of leaving the owner on a silent call
//   - SIGUSR2 (test hook only): engine.pause() to simulate the stall on a bench
//
// usage: injectin <deviceUID>
import AVFoundation
import CoreAudio
import Foundation

setbuf(stderr, nil)
func elog(_ s: String) { FileHandle.standardError.write(("injectin: " + s + "\n").data(using: .utf8)!) }

final class FloatFIFO {
    private var chunks: [[Float]] = []
    private var offset = 0
    private var total = 0
    private let lock = NSLock()
    var count: Int { lock.lock(); defer { lock.unlock() }; return total }
    func push(_ c: [Float]) {
        lock.lock(); defer { lock.unlock() }
        if total > 24000 * 300 { // runaway guard: 5 min buffered means something is wrong
            chunks.removeAll(); offset = 0; total = 0
        }
        chunks.append(c)
        total += c.count
    }
    func pop(into out: UnsafeMutablePointer<Float>, frames: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
        var filled = 0
        while filled < frames, let first = chunks.first {
            let avail = first.count - offset
            let take = min(avail, frames - filled)
            first.withUnsafeBufferPointer { bp in
                out.advanced(by: filled).update(from: bp.baseAddress! + offset, count: take)
            }
            filled += take
            offset += take
            total -= take
            if offset == first.count { chunks.removeFirst(); offset = 0 }
        }
        return filled
    }
    func clear() -> Int {
        lock.lock(); defer { lock.unlock() }
        let dropped = total
        chunks.removeAll(); offset = 0; total = 0
        return dropped
    }
}

func deviceID(forUID uid: String) -> AudioObjectID? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr else { return nil }
    for id in ids {
        var ua = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var s: CFString? = nil
        var sz = UInt32(MemoryLayout<CFString?>.size)
        let st = withUnsafeMutablePointer(to: &s) { p in AudioObjectGetPropertyData(id, &ua, 0, nil, &sz, p) }
        if st == noErr, (s as String?) == uid { return id }
    }
    return nil
}

let args = CommandLine.arguments
guard args.count >= 2 else { elog("usage: injectin <deviceUID>"); exit(1) }
let uid = args[1]
guard let devID = deviceID(forUID: uid) else { elog("device not found: \(uid)"); exit(1) }

let fifo = FloatFIFO()
let engine = AVAudioEngine()
guard let au = engine.outputNode.audioUnit else { elog("no audio unit"); exit(1) }
var dev = devID
let pinSt = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioObjectID>.size))
guard pinSt == noErr else { elog("failed to pin device: \(pinSt)"); exit(1) }
var srAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var nomRate: Float64 = 0
var srSize = UInt32(MemoryLayout<Float64>.size)
_ = AudioObjectGetPropertyData(devID, &srAddr, 0, nil, &srSize, &nomRate)
elog("pinned output id=\(devID) uid=\(uid) nominalRate=\(nomRate)Hz")

let srcFmt = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
var underrunFrames: UInt64 = 0
var renderedFrames: UInt64 = 0
var everHadData = false
let src = AVAudioSourceNode(format: srcFmt) { _, _, frameCount, abl -> OSStatus in
    let ablp = UnsafeMutableAudioBufferListPointer(abl)
    guard let raw = ablp[0].mData else { return noErr }
    let out = raw.assumingMemoryBound(to: Float.self)
    let n = Int(frameCount)
    let got = fifo.pop(into: out, frames: n)
    if got < n {
        for i in got..<n { out[i] = 0 } // underrun -> silence
        if everHadData { underrunFrames += UInt64(n - got) }
    } else {
        everHadData = true
    }
    renderedFrames += UInt64(n)
    return noErr
}
engine.attach(src)
// engine inserts the 24k mono -> device-rate converter on this connection
engine.connect(src, to: engine.mainMixerNode, format: srcFmt)
do { try engine.start() } catch { elog("engine start failed: \(error)"); exit(1) }
elog("engine running; reading PCM16/mono/24k from stdin")

// ---- stall self-heal ----
// The mouth is Inject-device-only by invariant (see header): if a restart can't land
// back on the Inject device, exiting beats silently playing into a default device.
var engineRestarts = 0
func restartEngine(reason: String) {
    engineRestarts += 1
    elog("ENGINE-RESTART #\(engineRestarts) (\(reason)): stopping, re-pinning \(uid), starting")
    engine.stop()
    guard let newID = deviceID(forUID: uid) else {
        elog("ENGINE-RESTART: device \(uid) is GONE — exiting (never falling back to another device)")
        exit(1)
    }
    var d = newID
    guard let au2 = engine.outputNode.audioUnit,
        AudioUnitSetProperty(au2, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &d, UInt32(MemoryLayout<AudioObjectID>.size)) == noErr
    else {
        elog("ENGINE-RESTART: re-pin failed — exiting (never falling back to another device)")
        exit(1)
    }
    do {
        try engine.start()
        elog("ENGINE-RESTART: engine running again (device id=\(newID))")
    } catch {
        elog("ENGINE-RESTART: start failed: \(error) — exiting")
        exit(1)
    }
}

// macOS stops (or wedges) the engine on device-graph changes under it — FaceTime
// reconfiguring the shared driver at connect is exactly that. Restart if it stopped;
// if it "survived" but the render loop is actually dead, the watchdog below catches it.
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
    if engine.isRunning {
        elog("configuration change (engine still running — watchdog armed)")
    } else {
        elog("configuration change stopped the engine — restarting")
        restartEngine(reason: "configuration change")
    }
}

// Render watchdog: a healthy engine renders continuously (silence on underrun), so a
// frozen rendered counter IS a stall no matter what isRunning claims. One restart per
// stall episode; a restart that doesn't unfreeze within another 2s = exit loudly.
var wdLastRendered: UInt64 = UInt64.max
var wdFrozenTicks = 0
var wdRestartedThisStall = false
let watchdog = Timer(timeInterval: 0.5, repeats: true) { _ in
    let r = renderedFrames
    if r != wdLastRendered {
        wdLastRendered = r
        wdFrozenTicks = 0
        wdRestartedThisStall = false
        return
    }
    wdFrozenTicks += 1
    if wdFrozenTicks < 4 { return } // >2s frozen
    if !wdRestartedThisStall {
        wdRestartedThisStall = true
        elog("MOUTH-STALL: rendered frozen at \(r) for \(Double(wdFrozenTicks) * 0.5)s (queued=\(fifo.count) underrun=\(underrunFrames) engineRunning=\(engine.isRunning)) — attempting engine restart")
        restartEngine(reason: "mouth stall")
        wdFrozenTicks = 0
    } else {
        elog("MOUTH-STALL: restart did not unfreeze the render loop — exiting so the session fails loudly")
        exit(1)
    }
}
RunLoop.main.add(watchdog, forMode: .default)

// SIGUSR2 = TEST HOOK ONLY: pause the engine to fake the live-call stall (render
// callbacks stop, queue keeps growing) so the watchdog path is provable off-call.
signal(SIGUSR2, SIG_IGN)
let stallSrc = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
stallSrc.setEventHandler {
    elog("DEBUG (SIGUSR2): pausing engine to simulate a render stall")
    engine.pause()
}
stallSrc.resume()

// reader thread: stdin -> FIFO
var eof = false
let reader = Thread {
    var buf = [UInt8](repeating: 0, count: 9600) // 200ms
    var carry: UInt8? = nil
    while true {
        let n = read(0, &buf, buf.count)
        if n <= 0 { eof = true; elog("stdin EOF"); break }
        var floats: [Float] = []
        floats.reserveCapacity((n + 1) / 2 + 1)
        var i = 0
        if let c = carry { // odd-byte carry from the previous read
            let v = Int16(bitPattern: UInt16(c) | (UInt16(buf[0]) << 8))
            floats.append(Float(v) / 32768.0)
            carry = nil
            i = 1
        }
        while i + 1 < n {
            let v = Int16(bitPattern: UInt16(buf[i]) | (UInt16(buf[i + 1]) << 8))
            floats.append(Float(v) / 32768.0)
            i += 2
        }
        if i < n { carry = buf[i] }
        fifo.push(floats)
    }
}
reader.stackSize = 1 << 20
reader.start()

// SIGUSR1 = flush (barge-in): drop all buffered audio NOW
signal(SIGUSR1, SIG_IGN)
let sigSrc = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
sigSrc.setEventHandler {
    let dropped = fifo.clear()
    elog("FLUSH (SIGUSR1): dropped \(dropped) frames (\(String(format: "%.2f", Double(dropped) / 24000))s)")
}
sigSrc.resume()

let term: @convention(c) (Int32) -> Void = { _ in exit(0) }
signal(SIGINT, term)
signal(SIGTERM, term)

// stats + exit-on-drain
let statTimer = Timer(timeInterval: 5.0, repeats: true) { _ in
    elog("stats: rendered=\(renderedFrames) queued=\(fifo.count) underrun=\(underrunFrames) engineRunning=\(engine.isRunning) restarts=\(engineRestarts)")
}
RunLoop.main.add(statTimer, forMode: .default)
let drainTimer = Timer(timeInterval: 0.25, repeats: true) { _ in
    if eof && fifo.count == 0 { elog("drained after EOF — exiting"); exit(0) }
}
RunLoop.main.add(drainTimer, forMode: .default)
RunLoop.main.run()
