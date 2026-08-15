// tapout — the EARS: continuously stream a CoreAudio process tap as raw
// PCM16 LE, MONO, 24000 Hz on STDOUT. stderr carries diagnostics only; stdout
// is pure audio bytes.
//
// Live-proven on real FaceTime calls. Notable properties:
//   - continuous (no duration), stops on SIGTERM/SIGINT or stdout close
//   - in-process resample: aggregate rate (48k/44.1k stereo float) -> 24k mono
//     int16 via AVAudioConverter (IO runs at the AGGREGATE's nominal
//     rate = clock subdevice rate, NOT the tap-format rate — honored here)
//   - retry-quietly: waits for the target process / tap instead of exiting
//
// usage:
//   tapout sys [excludePid ...]   # global output tap excluding pids (session
//                                 # passes injectin's pid so our own mouth can
//                                 # never enter our ears)
//   tapout name <procName>        # tap all processes with that name
//                                 # (e.g. avconferenced or FaceTime)
import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

setbuf(stderr, nil)
signal(SIGPIPE, SIG_IGN) // stdout close must not kill us mid-syscall; we exit on EPIPE

func elog(_ s: String) { FileHandle.standardError.write(("tapout: " + s + "\n").data(using: .utf8)!) }

func processObject(forPID pid: pid_t) -> AudioObjectID? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var p = pid
    var obj = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let st = withUnsafeMutablePointer(to: &p) { pp in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, UInt32(MemoryLayout<pid_t>.size), pp, &size, &obj)
    }
    guard st == noErr, obj != AudioObjectID(kAudioObjectUnknown) else { return nil }
    return obj
}

func allPids(named name: String) -> [pid_t] {
    let n = proc_listallpids(nil, 0)
    guard n > 0 else { return [] }
    var pids = [pid_t](repeating: 0, count: Int(n) * 2)
    let got = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    var out: [pid_t] = []
    for i in 0..<Int(got) where pids[i] > 0 {
        var nameBuf = [CChar](repeating: 0, count: 256)
        proc_name(pids[i], &nameBuf, UInt32(nameBuf.count))
        if String(cString: nameBuf) == name { out.append(pids[i]) }
    }
    return out
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    elog("usage: tapout sys [excludePid...] | tapout name <procName>")
    exit(1)
}
let mode = args[1]
let desc: CATapDescription

if mode == "sys" {
    let excludePids = args.dropFirst(2).compactMap { pid_t($0) }
    // exclude pids may not have audio objects yet (a process only gets one
    // after doing audio IO). Retry quietly — losing the exclusion would let
    // our own playback into our ears.
    var excl: [AudioObjectID] = []
    let deadline = Date().addingTimeInterval(30)
    while true {
        excl = excludePids.compactMap { processObject(forPID: $0) }
        if excl.count == excludePids.count || Date() > deadline { break }
        Thread.sleep(forTimeInterval: 0.5)
    }
    if excl.count < excludePids.count {
        elog("WARN: only \(excl.count)/\(excludePids.count) exclude pids resolved to audio objects — proceeding")
    }
    desc = CATapDescription(stereoGlobalTapButExcludeProcesses: excl)
    elog("mode=sys, excluding \(excl.count) process objects")
} else if mode == "name" {
    guard args.count >= 3 else { elog("name mode needs a process name"); exit(1) }
    let name = args[2]
    var objs: [AudioObjectID] = []
    var tries = 0
    while objs.isEmpty { // retry quietly until the process exists AND has done audio IO
        objs = allPids(named: name).compactMap { processObject(forPID: $0) }
        if objs.isEmpty {
            tries += 1
            if tries % 15 == 1 { elog("waiting for audio process '\(name)'…") }
            Thread.sleep(forTimeInterval: 2)
        }
    }
    desc = CATapDescription(stereoMixdownOfProcesses: objs)
    elog("mode=name '\(name)', tapping \(objs.count) process objects")
} else {
    elog("unknown mode \(mode)")
    exit(1)
}

desc.isPrivate = true
desc.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
var st = AudioHardwareCreateProcessTap(desc, &tapID)
var tapTries = 0
while st != noErr { // retry quietly (e.g. transient coreaudiod state)
    tapTries += 1
    if tapTries % 15 == 1 { elog("AudioHardwareCreateProcessTap failed (\(st)) — retrying") }
    Thread.sleep(forTimeInterval: 2)
    st = AudioHardwareCreateProcessTap(desc, &tapID)
}

// tap stream format
var fmtAddr = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var asbd = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
st = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &asbdSize, &asbd)
guard st == noErr else { elog("read tap format failed: \(st)"); exit(1) }
elog("tap format: \(asbd.mSampleRate)Hz ch=\(asbd.mChannelsPerFrame)")

// aggregate needs a clock subdevice: default OUTPUT device (never touches
// default input / BlackHole)
func defaultOutputUID() -> String {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id)
    var ua = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var s: CFString? = nil
    var sz = UInt32(MemoryLayout<CFString?>.size)
    _ = withUnsafeMutablePointer(to: &s) { p in AudioObjectGetPropertyData(id, &ua, 0, nil, &sz, p) }
    return (s as String?) ?? ""
}
let outUID = defaultOutputUID()
elog("aggregate clock subdevice: \(outUID)")

let aggUID = UUID().uuidString
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "fig-call-tapout",
    kAudioAggregateDeviceUIDKey: aggUID,
    kAudioAggregateDeviceMainSubDeviceKey: outUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: desc.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
guard st == noErr else { elog("create aggregate failed: \(st)"); AudioHardwareDestroyProcessTap(tapID); exit(1) }

// IO runs at the AGGREGATE's nominal rate, not the tap-claimed rate
var srAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var aggRate: Float64 = 0
var srSize = UInt32(MemoryLayout<Float64>.size)
if AudioObjectGetPropertyData(aggID, &srAddr, 0, nil, &srSize, &aggRate) == noErr, aggRate > 0 {
    if aggRate != asbd.mSampleRate { elog("aggregate runs at \(aggRate)Hz (tap claimed \(asbd.mSampleRate)Hz) — using \(aggRate)") }
    asbd.mSampleRate = aggRate
}

guard let inFmt = AVAudioFormat(streamDescription: &asbd) else { elog("bad tap format"); exit(1) }
guard let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true),
      let conv = AVAudioConverter(from: inFmt, to: outFmt) else { elog("cannot build converter \(asbd.mSampleRate)->24000"); exit(1) }
let ratio = 24000.0 / asbd.mSampleRate

var pending: AVAudioPCMBuffer? = nil
var convErrOnce = false
var cbCount = 0
var framesOut: UInt64 = 0
var peakWindow: Float = 0

var ioProcID: AudioDeviceIOProcID?
let q = DispatchQueue(label: "fig.call.tapout")
st = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggID, q) { _, inData, _, _, _ in
    cbCount += 1
    guard let buf = AVAudioPCMBuffer(pcmFormat: inFmt, bufferListNoCopy: inData, deallocator: nil) else { return }
    pending = buf
    let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 256
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
    var err: NSError? = nil
    let cs = conv.convert(to: outBuf, error: &err) { _, status in
        if let p = pending { pending = nil; status.pointee = .haveData; return p }
        status.pointee = .noDataNow
        return nil
    }
    if cs == .error {
        if !convErrOnce { convErrOnce = true; elog("convert error: \(String(describing: err))") }
        return
    }
    let frames = Int(outBuf.frameLength)
    guard frames > 0, let ch = outBuf.int16ChannelData else { return }
    framesOut += UInt64(frames)
    for i in 0..<frames { let v = abs(Float(ch[0][i]) / 32768.0); if v > peakWindow { peakWindow = v } }
    // stdout = pure PCM16 LE mono 24k
    var p = UnsafeRawPointer(ch[0])
    var remaining = frames * 2
    while remaining > 0 {
        let w = write(1, p, remaining)
        if w <= 0 { elog("stdout closed — exiting"); exit(0) }
        remaining -= w
        p = p.advanced(by: w)
    }
    if cbCount % 1000 == 0 { // ~every 10s at 512-frame slices
        elog("cb#\(cbCount) framesOut=\(framesOut) (\(String(format: "%.1f", Double(framesOut) / 24000))s) peak(window)=\(String(format: "%.4f", peakWindow))")
        peakWindow = 0
    }
}
guard st == noErr, let procID = ioProcID else { elog("create ioproc failed: \(st)"); exit(1) }
st = AudioDeviceStart(aggID, procID)
guard st == noErr else { elog("device start failed: \(st)"); exit(1) }
elog("streaming PCM16/mono/24k to stdout (agg \(aggRate)Hz ch=\(asbd.mChannelsPerFrame))")

let stop: @convention(c) (Int32) -> Void = { _ in CFRunLoopStop(CFRunLoopGetMain()) }
signal(SIGINT, stop)
signal(SIGTERM, stop)
CFRunLoopRun()

AudioDeviceStop(aggID, procID)
AudioDeviceDestroyIOProcID(aggID, procID)
AudioHardwareDestroyAggregateDevice(aggID)
AudioHardwareDestroyProcessTap(tapID)
elog("stopped, total framesOut=\(framesOut)")
