package com.fiberlens.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FiberLensGnssPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
