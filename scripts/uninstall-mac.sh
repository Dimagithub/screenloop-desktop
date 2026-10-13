#!/bin/bash
# Removes ScreenLoop and everything it stored on this Mac. Usage: bash uninstall-mac.sh [--keep-recordings] [--yes]
ID=com.devcom.screenloop
keep=0; yes=0
for a in "$@"; do [ "$a" = --keep-recordings ] && keep=1; [ "$a" = --yes ] && yes=1; done
if [ $yes = 0 ]; then
  echo "This removes the ScreenLoop app, your sign-in, permissions and settings$([ $keep = 0 ] && echo ', and any UNSENT recordings')."
  read -r -p "Continue? [y/N] " r; [ "$r" = y ] || [ "$r" = Y ] || exit 1
fi
pkill -x ScreenLoop 2>/dev/null; pkill -9 -f "ScreenLoop.app/Contents/MacOS/ffmpeg" 2>/dev/null
rm -rf /Applications/ScreenLoop.app ~/Downloads/ScreenLoop_*
tccutil reset ScreenCapture $ID >/dev/null 2>&1; tccutil reset Microphone $ID >/dev/null 2>&1
security delete-generic-password -s $ID >/dev/null 2>&1   # sign-in key
D=~/Library/Application\ Support/$ID
if [ $keep = 1 ]; then rm -rf "$D/secrets.bin" "$D/shots"; else rm -rf "$D"; fi
rm -rf ~/Library/Caches/$ID ~/Library/Preferences/$ID.plist ~/Library/WebKit/$ID ~/Library/HTTPStorages/$ID ~/Library/Saved\ Application\ State/$ID.savedState ~/Library/Logs/$ID
echo "Done. Reinstall from https://github.com/Dimagithub/screenloop-desktop/releases/latest"
