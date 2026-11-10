package io.github.sulmanahmad.driveatlas;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // DriveAtlas's own plugin lives in the app, so it is registered here before the bridge starts.
        registerPlugin(DriveAtlasStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
