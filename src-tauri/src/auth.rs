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

// ---- Session storage ----
// The sign-in session is kept in an AES-256-GCM encrypted file in the app data folder. Only the 32-byte
// key lives in the OS keychain, as ONE item, so macOS/Windows ask for keychain access once (not once per
// stored chunk, which made the "allow keychain" prompt repeat after every update of this unsigned app).
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const SERVICE: &str = "com.devcom.screenloop";
static KEY: OnceLock<[u8; 32]> = OnceLock::new();
static FILE: Mutex<()> = Mutex::new(());

fn master_key() -> Result<[u8; 32], String> {
    if let Some(k) = KEY.get() {
        return Ok(*k);
    }
    let entry = keyring::Entry::new(SERVICE, "master-key").map_err(|e| e.to_string())?;
    let key: [u8; 32] = match entry.get_password() {
        Ok(h) => {
            let b: Vec<u8> = (0..h.len() / 2).filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok()).collect();
            b.try_into().map_err(|_| "Stored key is damaged".to_string())?
        }
        Err(keyring::Error::NoEntry) => {
            let k: [u8; 32] = Aes256Gcm::generate_key(OsRng).into();
            entry.set_password(&k.iter().map(|b| format!("{b:02x}")).collect::<String>()).map_err(|e| e.to_string())?;
            k
        }
        Err(e) => return Err(e.to_string()),
    };
    Ok(*KEY.get_or_init(|| key))
}

fn file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("secrets.bin"))
}

fn load(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let Ok(raw) = std::fs::read(file(app)?) else { return Ok(HashMap::new()) };
    if raw.len() < 13 {
        return Ok(HashMap::new());
    }
    let key = master_key()?;
    let plain = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key)).decrypt(Nonce::from_slice(&raw[..12]), &raw[12..]);
    // unreadable (key changed / damaged): start empty, the user just signs in again
    Ok(plain.ok().and_then(|p| serde_json::from_slice(&p).ok()).unwrap_or_default())
}

fn save(app: &tauri::AppHandle, m: &HashMap<String, String>) -> Result<(), String> {
    let key = master_key()?;
    let c = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(c.encrypt(&nonce, serde_json::to_vec(m).map_err(|e| e.to_string())?.as_slice()).map_err(|e| e.to_string())?);
    std::fs::write(file(app)?, out).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let _g = FILE.lock().unwrap();
    Ok(load(&app)?.get(&key).cloned())
}

#[tauri::command]
pub fn secret_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let _g = FILE.lock().unwrap();
    let mut m = load(&app)?;
    m.insert(key, value);
    save(&app, &m)
}

#[tauri::command]
pub fn secret_remove(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let _g = FILE.lock().unwrap();
    let mut m = load(&app)?;
    m.remove(&key);
    save(&app, &m)
}
