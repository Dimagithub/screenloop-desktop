#!/bin/bash
# Imports the self-signed ScreenLoop code-signing cert into a temp keychain and trusts it for code signing.
set -euxo pipefail
K="$RUNNER_TEMP/sl.keychain-db"
echo "$MACOS_CERT_P12" | base64 --decode > "$RUNNER_TEMP/cs.p12"
security create-keychain -p x "$K"
security set-keychain-settings -lut 21600 "$K"
security unlock-keychain -p x "$K"
security import "$RUNNER_TEMP/cs.p12" -k "$K" -P "$MACOS_CERT_PW" -A
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k x "$K"
security list-keychains -d user -s "$K" $(security list-keychains -d user | tr -d '"')
openssl pkcs12 -in "$RUNNER_TEMP/cs.p12" -passin "pass:$MACOS_CERT_PW" -nokeys -clcerts -out "$RUNNER_TEMP/cs.crt" 2>/dev/null || openssl pkcs12 -legacy -in "$RUNNER_TEMP/cs.p12" -passin "pass:$MACOS_CERT_PW" -nokeys -clcerts -out "$RUNNER_TEMP/cs.crt"
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$RUNNER_TEMP/cs.crt"
security find-identity -v -p codesigning
