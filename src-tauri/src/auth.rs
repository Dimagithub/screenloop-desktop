//! One-shot loopback listener for desktop sign-in (RFC 8252 pattern): the web sign-in page redirects to
//! http://127.0.0.1:<port>/cb?access_token=…&refresh_token=…&state=…, which we hand to the UI.
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::Emitter;

#[tauri::command]
pub fn start_auth_listener(app: tauri::AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
        // Accept until we get a /cb request (ignore stray connections), with a 5 minute cap.
        let _ = listener.set_nonblocking(true);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        while std::time::Instant::now() < deadline {
            let Ok((mut s, _)) = listener.accept() else {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            };
            let _ = s.set_nonblocking(false);
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let target = req.lines().next().and_then(|l| l.split(' ').nth(1)).unwrap_or("");
            let ok = target.starts_with("/cb?");
            let body = if ok { "<html><body style='font-family:system-ui;background:#1b1f1d;color:#f1f4ec;display:grid;place-items:center;height:100vh'><h2>Signed in. You can close this tab and return to ScreenLoop.</h2></body></html>" } else { "Not found" };
            let _ = write!(s, "HTTP/1.1 {} X\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", if ok { 200 } else { 404 }, body.len(), body);
            if ok {
                let _ = app.emit("auth-callback", target.trim_start_matches("/cb?").to_string());
                break;
            }
        }
    });
    Ok(port)
}

// ---- Session storage in the OS keychain (macOS Keychain / Windows Credential Manager) ----
const SERVICE: &str = "com.devcom.screenloop";

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_remove(key: String) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, &key).map_err(|e| e.to_string())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
