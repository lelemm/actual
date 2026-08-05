package org.actualbudget;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private long syncServerHandle;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        syncServerHandle = EmbeddedSyncServer.start(
            getFilesDir().getAbsolutePath() + "/sync-server",
            5006
        );
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onDestroy() {
        if (syncServerHandle != 0) {
            EmbeddedSyncServer.stop(syncServerHandle);
            syncServerHandle = 0;
        }
        super.onDestroy();
    }
}
