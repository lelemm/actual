package org.actualbudget;

final class EmbeddedSyncServer {
    static {
        System.loadLibrary("actual_sync_server");
    }

    private EmbeddedSyncServer() {}

    static native long start(String dataDir, int port);

    static native void stop(long handle);

    static native String status(long handle);
}
