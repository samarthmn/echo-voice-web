import AppKit
import AVFoundation
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit

// A receive-only CLI: no camera/microphone APIs and no video output are registered.
private func report(_ values: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

private struct CaptureError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

private final class StopGate: @unchecked Sendable {
    private let lock = NSLock()
    private var result: String??
    private var continuation: CheckedContinuation<String?, Never>?

    func stop(_ reason: String? = nil) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = .some(reason)
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(returning: reason)
    }

    func wait() async -> String? {
        await withCheckedContinuation { waiting in
            lock.lock()
            if let result = result {
                lock.unlock()
                waiting.resume(returning: result)
            } else {
                continuation = waiting
                lock.unlock()
            }
        }
    }
}

private final class PCMFile {
    private let handle: FileHandle
    private(set) var byteCount: UInt32 = 0

    init(path: String) throws {
        // Refuse replacement or symlink traversal of the final path. The runner
        // must provide an owned 0700 parent directory and a new destination.
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw CaptureError("Could not create a new private audio file.") }
        handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: Self.header(bytes: 0))
    }

    private static func header(bytes: UInt32) -> Data {
        var data = Data()
        func word<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        data.append(Data("RIFF".utf8)); word(bytes + 36)
        data.append(Data("WAVEfmt ".utf8)); word(UInt32(16))
        word(UInt16(1)); word(UInt16(1)); word(UInt32(16_000))
        word(UInt32(32_000)); word(UInt16(2)); word(UInt16(16))
        data.append(Data("data".utf8)); word(bytes)
        return data
    }

    func append(_ sample: CMSampleBuffer) throws {
        guard CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              let description = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: asbd) else {
            throw CaptureError("ScreenCaptureKit returned an invalid audio sample.")
        }
        // ScreenCaptureKit promises the requested stream format. Fail closed
        // rather than reinterpret unexpected channels or sample rates.
        guard format.sampleRate == 16_000, format.channelCount == 1,
              format.commonFormat == .pcmFormatFloat32 else {
            throw CaptureError("ScreenCaptureKit returned an unsupported audio format.")
        }
        let frames = CMSampleBufferGetNumSamples(sample)
        guard frames > 0 else { return }
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else {
            throw CaptureError("Could not allocate the audio buffer.")
        }
        pcm.frameLength = AVAudioFrameCount(frames)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList)
        guard status == noErr, let channel = pcm.floatChannelData?[0] else {
            throw CaptureError("Could not read the application audio buffer.")
        }
        try appendSamples(UnsafeBufferPointer(start: channel, count: frames))
    }

    func appendSamples(_ samples: UnsafeBufferPointer<Float>) throws {
        guard UInt64(byteCount) + UInt64(samples.count) * 2 <= UInt64(UInt32.max) - 36 else {
            throw CaptureError("The recording reached the WAV file size limit.")
        }
        var output = Data(capacity: samples.count * 2)
        for value in samples {
            let clipped = value.isFinite ? min(1, max(-1, value)) : 0
            var encoded = Int16((clipped * 32767).rounded()).littleEndian
            withUnsafeBytes(of: &encoded) { output.append(contentsOf: $0) }
        }
        try handle.write(contentsOf: output)
        byteCount += UInt32(output.count)
    }

    func finish() throws {
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: Self.header(bytes: byteCount))
        try handle.synchronize()
        try handle.close()
    }
}

private final class AudioOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "app.echo.meeting-audio")
    let file: PCMFile
    let stop: StopGate
    init(file: PCMFile, stop: StopGate) { self.file = file; self.stop = stop }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        do { try file.append(sampleBuffer) }
        catch let error as CaptureError { stop.stop(error.message) }
        catch { stop.stop("Writing the audio recording failed.") }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stop.stop("macOS stopped application audio capture. Check Screen & System Audio Recording permission.")
    }
}

@main
private enum AudioCapture {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--check"] {
            let permission = CGPreflightScreenCaptureAccess()
            report(["state": permission ? "ready" : "permission_required", "ready": permission,
                    "permission": "screen_and_system_audio_recording", "microphone": false,
                    "camera": false, "video": false, "scope": "application_pid"])
            return
        }
        guard args.count == 4, args[0] == "--pid", let pid = Int32(args[1]), pid > 1,
              args[2] == "--output", args[3].hasPrefix("/"), args[3].hasSuffix(".wav") else {
            report(["state": "error", "detail": "Usage: --check or --pid <owned Chrome PID> --output <new absolute .wav path>"])
            exit(2)
        }
        guard CGPreflightScreenCaptureAccess() else {
            report(["state": "permission_required", "detail": "Allow Screen & System Audio Recording for the local runner in System Settings, then restart it. No permission prompt was opened."])
            exit(3)
        }
        do { try await capture(pid: pid, path: args[3]) }
        catch let error as CaptureError { report(["state": "error", "detail": error.message]); exit(1) }
        catch { report(["state": "error", "detail": "Application audio capture failed. Check the local runner and macOS recording permission."]); exit(1) }
    }

    private static func capture(pid: pid_t, path: String) async throws {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.bundleIdentifier == "com.google.Chrome" else {
            throw CaptureError("The supplied PID is not a running Google Chrome application.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let selected = content.applications.first(where: { $0.processID == pid }),
              let display = content.displays.first,
              selected.bundleIdentifier == "com.google.Chrome", !app.isTerminated else {
            throw CaptureError("The dedicated Chrome process is not available for capture. No other application was selected.")
        }
        let filter = SCContentFilter(display: display, including: [selected], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        if #available(macOS 15.0, *) { config.captureMicrophone = false }
        // Only an audio output is attached. No video frames are delivered or saved.
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false
        let file = try PCMFile(path: path)
        let stop = StopGate()
        let output = AudioOutput(file: file, stop: stop)
        let stream = SCStream(filter: filter, configuration: config, delegate: output)
        try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
        signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
        let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { stop.stop() }; source.resume(); return source
        }
        let lifetime = DispatchSource.makeTimerSource(queue: .global())
        lifetime.schedule(deadline: .now() + 1, repeating: 1)
        lifetime.setEventHandler { if app.isTerminated { stop.stop("The dedicated Chrome process exited.") } }
        lifetime.resume()
        defer { signals.forEach { $0.cancel() }; lifetime.cancel() }
        do { try await stream.startCapture() }
        catch { try? file.finish(); throw error }
        report(["state": "capturing", "pid": pid, "sampleRate": 16_000, "channels": 1,
                "microphone": false, "camera": false, "video": false])
        let reason = await stop.wait()
        try? await stream.stopCapture()
        try output.queue.sync { try file.finish() }
        if let reason = reason { throw CaptureError(reason) }
        guard file.byteCount > 0 else { throw CaptureError("No application audio samples were received.") }
        report(["state": "stopped", "samples": file.byteCount / 2, "durationSeconds": Double(file.byteCount) / 32_000])
    }
}
