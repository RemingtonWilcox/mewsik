// Mewsik iOS Now Playing integration.
//
// Bridges the Rust audio engine to:
//   - AVAudioSession (.playback category, so audio keeps playing when the
//     screen locks and we own the system "Now Playing" surface).
//   - MPNowPlayingInfoCenter (lock screen + Control Center display).
//   - MPRemoteCommandCenter (AirPods double-tap, lock screen play/pause/skip,
//     CarPlay, Apple Watch).
//
// Rust calls in via these C-ABI functions (declared on the Rust side as
// `extern "C"` in src/audio/now_playing.rs):
//   - mewsik_now_playing_setup(handler)
//   - mewsik_now_playing_update(...)
//   - mewsik_now_playing_clear()
//
// The handler is called from Rust's perspective whenever the user triggers a
// remote command (play, pause, skip, seek, etc.), with a small integer
// command ID. Rust translates that into an AudioCommand and dispatches it
// through the engine's command channel.

import Foundation
import AVFoundation
import MediaPlayer
import UIKit

// Command IDs must stay in sync with src/audio/now_playing.rs.
private let CMD_RESUME: Int32 = 0
private let CMD_PAUSE: Int32 = 1
private let CMD_TOGGLE: Int32 = 2
private let CMD_NEXT: Int32 = 3
private let CMD_PREV: Int32 = 4
private let CMD_STOP: Int32 = 5
private let CMD_SEEK: Int32 = 6
private let CMD_INTERRUPTED: Int32 = 7
private let CMD_RESET_OUTPUT: Int32 = 8

private final class MewsikNowPlaying {
    static let shared = MewsikNowPlaying()

    private var handler: (@convention(c) (Int32, Int64) -> Void)?
    private let lock = NSLock()
    private var didSetup = false
    private var artworkURL: String?
    private var cachedArtwork: MPMediaItemArtwork?
    /// Generated artwork for items without any (most radio stations), cached
    /// for the title it was drawn from.
    private var placeholderTitle: String?
    private var placeholderArtwork: MPMediaItemArtwork?
    /// Last info pushed to the system, re-asserted when we regain the session.
    private var lastInfo: [String: Any]?

    func setup(handler: @escaping @convention(c) (Int32, Int64) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        if didSetup {
            self.handler = handler
            return
        }
        didSetup = true
        self.handler = handler

        // Activate playback audio session so audio survives screen lock and
        // we become the "Now Playing" app for AirPods/lock-screen controls.
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            NSLog("[mewsik] failed to configure AVAudioSession: \(error)")
        }

        // Interruptions: another app's audio (TikTok, a call, Siri) stops our
        // AudioUnit. Tell the engine so it pauses cleanly and rebuilds the
        // output before it plays again.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        // The media server restarted under us: every audio object is invalid.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: nil
        )
        // AirPods taken out / unplugged: pause, like every other player.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        // Coming back to the foreground: make sure the lock screen shows us.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleDidBecomeActive(_:)),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )

        let center = MPRemoteCommandCenter.shared()

        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            self?.activateSession()
            self?.dispatch(CMD_RESUME, 0)
            return .success
        }

        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            self?.dispatch(CMD_PAUSE, 0)
            return .success
        }

        center.togglePlayPauseCommand.isEnabled = true
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.activateSession()
            self?.dispatch(CMD_TOGGLE, 0)
            return .success
        }

        center.stopCommand.isEnabled = true
        center.stopCommand.addTarget { [weak self] _ in
            self?.dispatch(CMD_STOP, 0)
            return .success
        }

        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.dispatch(CMD_NEXT, 0)
            return .success
        }

        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.dispatch(CMD_PREV, 0)
            return .success
        }

        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.dispatch(CMD_SEEK, Int64(event.positionTime * 1000))
            return .success
        }
    }

    private func dispatch(_ cmd: Int32, _ payload: Int64) {
        let h: (@convention(c) (Int32, Int64) -> Void)? = {
            lock.lock(); defer { lock.unlock() }
            return handler
        }()
        h?(cmd, payload)
    }

    private func activateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            NSLog("[mewsik] failed to activate AVAudioSession: \(error)")
        }
    }

    /// Push the last known info again. iOS hands the lock screen to whichever
    /// app last set info while holding the session, so after another app
    /// played we have to say "we are back".
    private func reassert() {
        guard let info = lastInfo else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    @objc private func handleInterruption(_ note: Notification) {
        guard
            let info = note.userInfo,
            let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeRaw)
        else { return }

        switch type {
        case .began:
            dispatch(CMD_INTERRUPTED, 0)
        case .ended:
            activateSession()
            dispatch(CMD_RESET_OUTPUT, 0)
            reassert()
            let optionsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            if options.contains(.shouldResume) {
                dispatch(CMD_RESUME, 0)
            }
        @unknown default:
            break
        }
    }

    @objc private func handleMediaServicesReset(_ note: Notification) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        activateSession()
        dispatch(CMD_RESET_OUTPUT, 0)
        reassert()
    }

    @objc private func handleRouteChange(_ note: Notification) {
        guard
            let info = note.userInfo,
            let reasonRaw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw)
        else { return }
        if reason == .oldDeviceUnavailable {
            dispatch(CMD_PAUSE, 0)
        }
    }

    @objc private func handleDidBecomeActive(_ note: Notification) {
        reassert()
    }

    func update(
        title: String,
        artist: String,
        album: String,
        artworkURL: String,
        durationMs: Int64,
        positionMs: Int64,
        isPlaying: Bool,
        isLive: Bool
    ) {
        var info: [String: Any] = [:]
        info[MPMediaItemPropertyTitle] = title
        if !artist.isEmpty { info[MPMediaItemPropertyArtist] = artist }
        if !album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = album }

        // iOS hides station info on the lock screen when isLive=true AND
        // playbackRate=0 (it interprets a paused live stream as "Not Playing").
        // So only mark as live while we're actually playing; when paused, leave
        // duration/rate fields off so iOS keeps the metadata visible without
        // showing scrubber state that doesn't apply to radio.
        if isLive && isPlaying {
            info[MPNowPlayingInfoPropertyIsLiveStream] = true
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, Double(positionMs)) / 1000.0
            info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        } else if !isLive {
            if durationMs > 0 {
                info[MPMediaItemPropertyPlaybackDuration] = Double(durationMs) / 1000.0
            }
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, Double(positionMs)) / 1000.0
            info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        }
        // If isLive && !isPlaying: only title/artist/album/artwork are set.
        // iOS keeps the metadata visible and the play button shows "play".

        if let cached = cachedArtwork, self.artworkURL == artworkURL {
            info[MPMediaItemPropertyArtwork] = cached
        } else {
            // No artwork, or it is still downloading: show the generated
            // tile so the lock screen is never blank.
            info[MPMediaItemPropertyArtwork] = generatedArtwork(for: title)
        }

        lastInfo = info
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if !artworkURL.isEmpty && artworkURL != self.artworkURL {
            self.artworkURL = artworkURL
            loadArtwork(from: artworkURL)
        } else if artworkURL.isEmpty {
            self.artworkURL = nil
            self.cachedArtwork = nil
        }
    }

    private func loadArtwork(from urlString: String) {
        guard let url = URL(string: urlString) else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard
                let self = self,
                let data = data,
                let image = UIImage(data: data),
                self.artworkURL == urlString
            else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                self.cachedArtwork = artwork
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPMediaItemPropertyArtwork] = artwork
                    self.lastInfo = info
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
            }
        }.resume()
    }

    /// Two-tone gradient plus monogram, deterministic from the title. Mirrors
    /// the in-app StationArt tile (src/lib/components/station-art.svelte):
    /// same FNV-1a seed over the title's code points, same hues and angle.
    private func generatedArtwork(for title: String) -> MPMediaItemArtwork {
        if let cached = placeholderArtwork, placeholderTitle == title {
            return cached
        }

        // FNV-1a, as stationSeed() in src/lib/radio/names.ts.
        var hash: UInt32 = 0x811c9dc5
        for scalar in title.unicodeScalars {
            hash ^= scalar.value
            hash = hash &* 0x01000193
        }
        let seed = Double(hash) / Double(UInt32.max)

        let hueA = (seed * 360).rounded()
        let hueB = (seed * 360 + 38 + seed * 70).truncatingRemainder(dividingBy: 360).rounded()
        let angle = (120 + seed * 120).rounded() * Double.pi / 180
        let colorA = hslColor(hueA, 0.58, 0.30, 1)
        let colorB = hslColor(hueB, 0.62, 0.16, 1)

        let side: CGFloat = 512
        let size = CGSize(width: side, height: side)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let image = renderer.image { rendererContext in
            let ctx = rendererContext.cgContext
            let space = CGColorSpaceCreateDeviceRGB()
            let center = CGPoint(x: side / 2, y: side / 2)

            // CSS linear-gradient(angle): 0deg points up, clockwise.
            let dx = CGFloat(sin(angle))
            let dy = CGFloat(-cos(angle))
            let half = (abs(dx) + abs(dy)) * side / 2
            if let base = CGGradient(
                colorsSpace: space,
                colors: [colorA.cgColor, colorB.cgColor] as CFArray,
                locations: [0, 1]
            ) {
                ctx.drawLinearGradient(
                    base,
                    start: CGPoint(x: center.x - dx * half, y: center.y - dy * half),
                    end: CGPoint(x: center.x + dx * half, y: center.y + dy * half),
                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
                )
            }

            // Soft highlight, like the radial layer at 40% opacity.
            let glowCenter = CGPoint(x: side * CGFloat(0.2 + seed * 0.6), y: side * 0.18)
            let farX = max(glowCenter.x, side - glowCenter.x)
            let farY = max(glowCenter.y, side - glowCenter.y)
            let glowRadius = 0.6 * (farX * farX + farY * farY).squareRoot()
            let glow = hslColor(hueB, 0.80, 0.60, 0.22)
            if let highlight = CGGradient(
                colorsSpace: space,
                colors: [glow.cgColor, glow.withAlphaComponent(0).cgColor] as CFArray,
                locations: [0, 1]
            ) {
                ctx.drawRadialGradient(
                    highlight,
                    startCenter: glowCenter,
                    startRadius: 0,
                    endCenter: glowCenter,
                    endRadius: glowRadius,
                    options: []
                )
            }

            let text = monogram(for: title) as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: side * 0.34, weight: .semibold),
                .foregroundColor: UIColor(white: 1, alpha: 0.85),
            ]
            let textSize = text.size(withAttributes: attributes)
            text.draw(
                at: CGPoint(x: (side - textSize.width) / 2, y: (side - textSize.height) / 2),
                withAttributes: attributes
            )
        }

        let artwork = MPMediaItemArtwork(boundsSize: size) { _ in image }
        placeholderTitle = title
        placeholderArtwork = artwork
        return artwork
    }

    /// One or two characters: initials of the first two words, or the first
    /// two characters of a single word (stationMonogram() in names.ts).
    private func monogram(for title: String) -> String {
        let words = title
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
        guard let first = words.first else { return "?" }
        if words.count == 1 {
            return String(first.prefix(2)).uppercased()
        }
        return (String(first.prefix(1)) + String(words[1].prefix(1))).uppercased()
    }

    /// CSS hsl() to UIColor, which takes hue/saturation/brightness (HSB).
    private func hslColor(_ hue: Double, _ saturation: Double, _ lightness: Double, _ alpha: Double) -> UIColor {
        let brightness = lightness + saturation * min(lightness, 1 - lightness)
        let hsbSaturation = brightness == 0 ? 0 : 2 * (1 - lightness / brightness)
        return UIColor(
            hue: CGFloat(hue / 360),
            saturation: CGFloat(hsbSaturation),
            brightness: CGFloat(brightness),
            alpha: CGFloat(alpha)
        )
    }

    func clear() {
        lastInfo = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        artworkURL = nil
        cachedArtwork = nil
    }
}

// MARK: - C-ABI bridge for Rust

@_cdecl("mewsik_now_playing_setup")
public func mewsik_now_playing_setup(
    handler: @escaping @convention(c) (Int32, Int64) -> Void
) {
    DispatchQueue.main.async {
        MewsikNowPlaying.shared.setup(handler: handler)
    }
}

private func cstring(_ ptr: UnsafePointer<CChar>?) -> String {
    guard let ptr = ptr else { return "" }
    return String(cString: ptr)
}

@_cdecl("mewsik_now_playing_update")
public func mewsik_now_playing_update(
    title: UnsafePointer<CChar>?,
    artist: UnsafePointer<CChar>?,
    album: UnsafePointer<CChar>?,
    artworkURL: UnsafePointer<CChar>?,
    durationMs: Int64,
    positionMs: Int64,
    isPlaying: Bool,
    isLive: Bool
) {
    let t = cstring(title)
    let a = cstring(artist)
    let al = cstring(album)
    let art = cstring(artworkURL)
    DispatchQueue.main.async {
        MewsikNowPlaying.shared.update(
            title: t,
            artist: a,
            album: al,
            artworkURL: art,
            durationMs: durationMs,
            positionMs: positionMs,
            isPlaying: isPlaying,
            isLive: isLive
        )
    }
}

@_cdecl("mewsik_now_playing_clear")
public func mewsik_now_playing_clear() {
    DispatchQueue.main.async {
        MewsikNowPlaying.shared.clear()
    }
}
