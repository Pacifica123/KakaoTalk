# Relay Chat — minimal Android TCP client

React Native / Expo client for the single-file Python relay messenger supplied with this project.

The wire format intentionally matches the original `messenger.py`:

- 4-byte big-endian header length
- UTF-8 JSON header
- body length taken from `text_length`
- message payload is UTF-8 unless `compressed=true`
- `hello`, `hello_ok`, `message`, `list`, `users`, `ping`, `pong`, `error`

The Android transport is `react-native-tcp-socket`, not `fetch`, WebSocket, or an HTTP client. The library exposes native TCP connections and a configurable connection timeout; on Android this project forces the `wifi` interface so a local-LAN test does not silently switch to cellular. See the package API for the supported connection options: https://github.com/Rapsssito/react-native-tcp-socket

## Important: Expo Go

Do not test the TCP part in ordinary Expo Go. `react-native-tcp-socket` contains native Android code, so the app must be prebuilt into an APK/development build. EAS Build is the intended path here.

## Local EAS build

Requires Node 24 and an Expo/EAS account.

```bash
npm install
npx expo prebuild
npx eas login
npx eas build --platform android --profile apk
```

The generated artifact is an installable APK.

## GitHub → APK

1. Push this directory to a GitHub repository.
2. Create an Expo access token.
3. In GitHub repository settings, create the Actions secret `EXPO_TOKEN`.
4. Push to `main` or run **Build Android APK** manually from GitHub Actions.

The workflow is `.github/workflows/build-android.yml`.

## Running against the supplied Python server

On the PC:

```bash
python messenger.py server --host 0.0.0.0 --port 9000
```

Find the PC's LAN IPv4 address, e.g. `192.168.1.20`, and enter:

- Server: `192.168.1.20`
- Port: `9000`
- Name: `android`

The Python client can then connect as another user, for example `alice`.

## Why this build does not endlessly retry

The original Python client catches `OSError`, `TimeoutError`, and `ConnectionError`, prints `Connection failed`, sleeps three seconds, and retries forever. That is convenient for a daemon but terrible for diagnosing a phone connection problem.

This Android client performs one connection attempt and reports:

- exact native socket error code, when available
- native error message
- failure stage (`tcp-connect`, `handshake`, `protocol`, `socket`, `send`)
- a concrete interpretation for common errors such as `ECONNREFUSED`, `ETIMEDOUT`, `ENETUNREACH`, `EHOSTUNREACH`, `ECONNRESET`, and DNS resolution failures
- Android local IPv4 and network type

No automatic retry is done. Press **CONNECT** after correcting the cause.

## What the diagnostic result means

`ECONNREFUSED` means the device reached the target address but nothing accepted the TCP connection on that port, or a firewall rejected it.

`ETIMEDOUT` means no successful TCP response arrived before 5 seconds. For a LAN test, check the address, port, server bind address, firewall, Wi‑Fi client isolation/AP isolation, and VPN.

`ENETUNREACH` / `EHOSTUNREACH` means Android has no usable route to the destination.

A successful TCP connection followed by `handshake` failure means networking itself works and the problem is at the application/protocol level.

## Deliberate limitations

This is intentionally not a production messenger:

- no encryption
- no authentication
- no persistence
- no attachments
- no background service
- no push notifications
- no message delivery guarantees
- compressed incoming messages are displayed as an explicit unsupported notice rather than being silently decoded incorrectly

The point is a small, debuggable Android client for the existing relay protocol.

## Web

The project keeps Expo web configuration so the repository remains a normal Expo universal project, but the TCP messenger screen refuses to pretend that browser JavaScript has the same raw-TCP capability as the Android native build. The web target is therefore a diagnostic placeholder, not a second transport implementation.
