use std::path::PathBuf;

use jni::{
    JNIEnv,
    objects::{JClass, JString},
    sys::{jint, jlong, jstring},
};

use crate::embedded;

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_actualbudget_EmbeddedSyncServer_start(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    port: jint,
) -> jlong {
    let result = (|| {
        let data_dir = env
            .get_string(&data_dir)
            .map_err(|error| error.to_string())?;
        let port = u16::try_from(port).map_err(|_| "port must be between 1 and 65535")?;
        embedded::start(
            &PathBuf::from(data_dir.to_string_lossy().into_owned()),
            port,
        )
    })();
    match result {
        Ok(handle) => handle as jlong,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_actualbudget_EmbeddedSyncServer_stop(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if let Err(error) = embedded::stop(handle as u64) {
        let _ = env.throw_new("java/lang/IllegalStateException", error);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_actualbudget_EmbeddedSyncServer_status(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    match embedded::status(handle as u64).and_then(|status| {
        env.new_string(status.as_str())
            .map_err(|error| error.to_string())
    }) {
        Ok(status) => status.into_raw(),
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}
