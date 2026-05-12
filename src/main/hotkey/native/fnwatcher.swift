// fnwatcher — tiny macOS sidecar binary that surfaces Fn (Globe) key
// down/up edges to its parent process via stdout.
//
// Why this exists
// ---------------
// uiohook-napi never delivers Fn key events on macOS. Internally libuiohook
// only handles `kCGEventFlagsChanged` for Shift/Ctrl/Option/Cmd and ignores
// `kVK_Function` (0x3F), so the JS layer can never see Fn down/up.
//
// macOS does, however, deliver Fn flag changes through a regular event tap:
// every press toggles the `kCGEventFlagMaskSecondaryFn` (1 << 23) bit on a
// `kCGEventFlagsChanged` event. We tap that, filter by `kVK_Function`, and
// print a single line per edge:
//
//   FN_DOWN\n
//   FN_UP\n
//
// stdout is line-buffered. The parent (Electron main) spawns this binary
// once at app launch on macOS and reads its stdout.
//
// Shutdown
// --------
// Reads from stdin on a background queue. EOF (parent closed the pipe / quit)
// exits the process cleanly. This avoids zombie watcher processes if the
// Electron app crashes without killing children.
//
// Signing / sandboxing
// --------------------
// Uses only the public CGEventTap APIs. Needs the Accessibility entitlement
// (same as uiohook-napi already requires for the main app). When packaged
// inside `WindVoice.app/Contents/Resources/native/`, the app's TCC bundle
// authorization extends to child processes spawned from the bundle, so the
// user does not see a separate Accessibility prompt for fnwatcher.

import Cocoa

// Per IOKit headers, kVK_Function == 0x3F (63) is the keycode that macOS
// reports for the Globe / Fn key in a kCGEventFlagsChanged event.
private let kFnKeycode: Int64 = 0x3F
// kCGEventFlagMaskSecondaryFn = 1 << 23 = 0x800000. Defined in
// CGEventTypes.h. Hardcoded here so we don't depend on a deprecated alias.
private let kFnFlagMask: UInt64 = 0x800000

// Tracks the last reported state so we only emit on true edges. macOS does
// fire multiple FlagsChanged events for the same physical press in some
// configurations (e.g. with Karabiner-Elements installed); de-duplication
// keeps the parent's heldDown set sane.
private var fnIsDown = false

private func emit(_ line: String) {
    // Single write + newline. stdout is line-buffered when connected to a
    // pipe but we flush explicitly to be safe — the parent reads with a
    // line-oriented split, so a buffered partial line would stall it.
    print(line)
    fflush(stdout)
}

private let eventCallback: CGEventTapCallBack = { _, type, event, _ in
    // tap-disabled-by-timeout fires if the kernel thinks our callback is
    // too slow. Re-enable and continue — the alternative is silent death.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = gEventTap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }

    guard type == .flagsChanged else {
        return Unmanaged.passUnretained(event)
    }

    let keycode = event.getIntegerValueField(.keyboardEventKeycode)
    guard keycode == kFnKeycode else {
        return Unmanaged.passUnretained(event)
    }

    let flags = event.flags
    let fnNow = (flags.rawValue & kFnFlagMask) != 0

    if fnNow && !fnIsDown {
        fnIsDown = true
        emit("FN_DOWN")
    } else if !fnNow && fnIsDown {
        fnIsDown = false
        emit("FN_UP")
    }

    return Unmanaged.passUnretained(event)
}

// File-scope so the callback can re-enable the tap on timeout. Optional
// because we can only construct it after the run loop is set up.
private var gEventTap: CFMachPort?

private func installTap() -> Bool {
    let mask: CGEventMask = 1 << CGEventType.flagsChanged.rawValue
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: eventCallback,
        userInfo: nil
    ) else {
        FileHandle.standardError.write(Data("fnwatcher: failed to create event tap (Accessibility permission missing?)\n".utf8))
        return false
    }
    gEventTap = tap
    let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
}

// Read stdin in a background thread. When the parent closes the pipe, read
// returns 0 and we exit cleanly. This is the only graceful-shutdown path —
// the parent uses it to signal "I'm gone, stop running".
private func watchStdinForEof() {
    DispatchQueue.global(qos: .utility).async {
        let fd = FileHandle.standardInput.fileDescriptor
        var buf = [UInt8](repeating: 0, count: 256)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 {
                // EOF or error → parent is gone. Exit on the main thread so
                // run loop teardown is clean.
                DispatchQueue.main.async {
                    exit(0)
                }
                return
            }
        }
    }
}

// SIGTERM / SIGINT → graceful exit. Also catches the case where the parent
// kills us explicitly rather than via stdin EOF.
private func installSignalHandlers() {
    signal(SIGTERM) { _ in exit(0) }
    signal(SIGINT) { _ in exit(0) }
    // SIGPIPE on stdout (parent stopped reading) — die quietly instead of
    // crashing.
    signal(SIGPIPE, SIG_IGN)
}

installSignalHandlers()
watchStdinForEof()

if !installTap() {
    exit(1)
}

emit("FN_READY")
CFRunLoopRun()
