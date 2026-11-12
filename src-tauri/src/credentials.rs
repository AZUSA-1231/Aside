use serde_json::{Map, Value};

/// Credential slots.
///
/// `custom` is the user-declared API route. It is not a built-in provider with
/// a model catalog, but its key lives in the same native store under its own
/// target name, so a custom Base URL can never be sent a built-in vendor's key.
pub const PROVIDERS: [&str; 5] = ["openai", "anthropic", "deepseek", "google", "custom"];

pub fn validate_provider(provider: &str) -> Result<(), &'static str> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err("Select a supported API provider.")
    }
}

pub fn validate_key(key: &str) -> Result<(), &'static str> {
    if !key.is_empty()
        && key.len() <= 2048
        && key
            .bytes()
            .all(|character| (0x21..=0x7e).contains(&character))
    {
        Ok(())
    } else {
        Err("The API key must contain 1–2048 printable characters without spaces.")
    }
}

pub fn read_api_keys() -> Result<Value, &'static str> {
    let mut keys = Map::new();
    for provider in PROVIDERS {
        if let Some(key) = platform::read(provider)? {
            keys.insert(provider.into(), Value::String(key));
        }
    }
    Ok(Value::Object(keys))
}

pub fn read_api_keys_status() -> (Value, Vec<&'static str>) {
    status_from(platform::read)
}

fn status_from(
    read: impl Fn(&str) -> Result<Option<String>, &'static str>,
) -> (Value, Vec<&'static str>) {
    let mut keys = Map::new();
    let mut errors = Vec::new();
    for provider in PROVIDERS {
        match read(provider) {
            Ok(Some(key)) => {
                keys.insert(provider.into(), Value::String(key));
            }
            Ok(None) => {}
            Err(_) => errors.push(provider),
        }
    }
    (Value::Object(keys), errors)
}

pub fn write_api_key(provider: &str, key: Option<&str>) -> Result<(), &'static str> {
    validate_provider(provider)?;
    if let Some(key) = key {
        validate_key(key)?;
    }
    platform::write(provider, key)
}

#[cfg(windows)]
mod platform {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn target(provider: &str) -> Vec<u16> {
        format!("Aside/API/{provider}")
            .encode_utf16()
            .chain(Some(0))
            .collect()
    }

    pub fn read(provider: &str) -> Result<Option<String>, &'static str> {
        let target = target(provider);
        read_target(&target)
    }

    fn read_target(target: &[u16]) -> Result<Option<String>, &'static str> {
        let mut credential = std::ptr::null_mut();
        unsafe {
            if let Err(error) = CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            ) {
                return if error.code() == ERROR_NOT_FOUND.to_hresult() {
                    Ok(None)
                } else {
                    Err("Windows Credential Manager could not read Aside's API credentials.")
                };
            }
            if credential.is_null() {
                return Err("Windows returned an invalid Aside credential.");
            }
            let data = &*credential;
            let result = if data.CredentialBlob.is_null()
                || data.CredentialBlobSize == 0
                || data.CredentialBlobSize > 2048
            {
                Err("The stored Aside credential is invalid. Replace or remove it.")
            } else {
                String::from_utf8(
                    std::slice::from_raw_parts(
                        data.CredentialBlob,
                        data.CredentialBlobSize as usize,
                    )
                    .to_vec(),
                )
                .map_err(|_| "The stored Aside credential is invalid. Replace or remove it.")
                .and_then(|key| {
                    super::validate_key(&key)?;
                    Ok(Some(key))
                })
            };
            CredFree(credential.cast());
            result
        }
    }

    pub fn write(provider: &str, key: Option<&str>) -> Result<(), &'static str> {
        let mut target = target(provider);
        write_target(&mut target, key)
    }

    fn write_target(target: &mut [u16], key: Option<&str>) -> Result<(), &'static str> {
        unsafe {
            let Some(key) = key else {
                return match CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) {
                    Ok(()) => Ok(()),
                    Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
                    Err(_) => Err("Windows Credential Manager could not remove the API key."),
                };
            };
            let mut bytes = key.as_bytes().to_vec();
            let mut username: Vec<u16> = "Aside\0".encode_utf16().collect();
            let credential = CREDENTIALW {
                Type: CRED_TYPE_GENERIC,
                TargetName: PWSTR(target.as_mut_ptr()),
                CredentialBlobSize: bytes.len() as u32,
                CredentialBlob: bytes.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                UserName: PWSTR(username.as_mut_ptr()),
                ..Default::default()
            };
            CredWriteW(&credential, 0)
                .map_err(|_| "Windows Credential Manager could not save the API key.")
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct TestCredential(Vec<u16>);
        impl Drop for TestCredential {
            fn drop(&mut self) {
                let _ = write_target(&mut self.0, None);
            }
        }

        #[test]
        fn windows_credentials_roundtrip_uses_an_isolated_disposable_target() {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let mut target = TestCredential(
                format!("Aside/Test/API/{}/{nonce}", std::process::id())
                    .encode_utf16()
                    .chain(Some(0))
                    .collect(),
            );
            assert_eq!(read_target(&target.0).unwrap(), None);
            write_target(&mut target.0, Some("disposable-fixture-key")).unwrap();
            assert_eq!(
                read_target(&target.0).unwrap().as_deref(),
                Some("disposable-fixture-key")
            );
            write_target(&mut target.0, Some("replacement-fixture-key")).unwrap();
            assert_eq!(
                read_target(&target.0).unwrap().as_deref(),
                Some("replacement-fixture-key")
            );
            write_target(&mut target.0, None).unwrap();
            assert_eq!(read_target(&target.0).unwrap(), None);
            write_target(&mut target.0, None).unwrap();
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn read(_provider: &str) -> Result<Option<String>, &'static str> {
        Ok(None)
    }
    pub fn write(_provider: &str, _key: Option<&str>) -> Result<(), &'static str> {
        Err("API credential storage is currently available on Windows only.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_unreadable_credential_does_not_block_settings_recovery() {
        let (keys, errors) = status_from(|provider| match provider {
            "openai" => Err("unreadable fixture"),
            "google" => Ok(Some("fixture-private-key".into())),
            _ => Ok(None),
        });
        assert_eq!(errors, vec!["openai"]);
        assert!(keys["openai"].is_null());
        assert_eq!(keys["google"], "fixture-private-key");
    }

    #[test]
    fn credential_validation_is_bounded_and_does_not_echo_keys() {
        assert!(validate_key("unit-test-credential").is_ok());
        for invalid in ["", "private value", "key\nvalue", &"x".repeat(2049)] {
            let error = validate_key(invalid).unwrap_err();
            assert!(!error.contains("private value"));
        }
        assert!(validate_provider("../../outside").is_err());
        for provider in PROVIDERS {
            assert!(validate_provider(provider).is_ok());
        }
    }
}
