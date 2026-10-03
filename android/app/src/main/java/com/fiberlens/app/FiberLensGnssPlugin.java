package com.fiberlens.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.location.GnssStatus;
import android.location.LocationManager;
import android.location.OnNmeaMessageListener;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Set;
import java.util.UUID;

/**
 * FiberLens native GNSS bridge:
 *  - GnssStatus (satellites used / in view) and raw NMEA from the phone receiver
 *  - Bluetooth Classic SPP connection to external GNSS / RTK receivers (NMEA stream)
 */
@CapacitorPlugin(
    name = "FiberLensGnss",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "location"),
        @Permission(strings = { "android.permission.BLUETOOTH_CONNECT", "android.permission.BLUETOOTH_SCAN" }, alias = "bluetooth")
    }
)
public class FiberLensGnssPlugin extends Plugin {
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private LocationManager lm;
    private GnssStatus.Callback statusCallback;
    private OnNmeaMessageListener nmeaListener;
    private BluetoothSocket socket;
    private Thread readerThread;
    private volatile boolean reading = false;

    @Override
    public void load() {
        lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
    }

    // ---------------- phone GNSS status + NMEA ----------------
    @PluginMethod
    public void startStatus(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermsCallback");
            return;
        }
        doStartStatus(call);
    }

    @PermissionCallback
    private void locationPermsCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) doStartStatus(call);
        else call.reject("Location permission denied");
    }

    @SuppressLint("MissingPermission")
    private void doStartStatus(PluginCall call) {
        stopStatusInternal();
        final Handler handler = new Handler(Looper.getMainLooper());
        statusCallback = new GnssStatus.Callback() {
            @Override
            public void onSatelliteStatusChanged(GnssStatus status) {
                int used = 0;
                int count = status.getSatelliteCount();
                float cn0sum = 0;
                for (int i = 0; i < count; i++) {
                    if (status.usedInFix(i)) { used++; cn0sum += status.getCn0DbHz(i); }
                }
                JSObject o = new JSObject();
                o.put("used", used);
                o.put("inView", count);
                o.put("avgCn0", used > 0 ? cn0sum / used : 0);
                notifyListeners("gnssStatus", o);
            }
        };
        try {
            lm.registerGnssStatusCallback(statusCallback, handler);
            nmeaListener = (message, timestamp) -> {
                JSObject o = new JSObject();
                o.put("sentence", message);
                o.put("t", timestamp);
                notifyListeners("nmea", o);
            };
            lm.addNmeaListener(nmeaListener, handler);
            call.resolve();
        } catch (Exception e) {
            call.reject("GNSS status unavailable: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopStatus(PluginCall call) {
        stopStatusInternal();
        call.resolve();
    }

    private void stopStatusInternal() {
        try {
            if (statusCallback != null) lm.unregisterGnssStatusCallback(statusCallback);
            if (nmeaListener != null) lm.removeNmeaListener(nmeaListener);
        } catch (Exception ignored) { }
        statusCallback = null;
        nmeaListener = null;
    }

    // ---------------- Bluetooth Classic (SPP) receivers ----------------
    private boolean needsBtPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    @PluginMethod
    public void listBondedDevices(PluginCall call) {
        if (needsBtPermission()) { requestPermissionForAlias("bluetooth", call, "btListCallback"); return; }
        doList(call);
    }

    @PermissionCallback
    private void btListCallback(PluginCall call) {
        if (needsBtPermission()) call.reject("Bluetooth permission denied");
        else doList(call);
    }

    @SuppressLint("MissingPermission")
    private void doList(PluginCall call) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) { call.reject("Bluetooth not available"); return; }
        if (!adapter.isEnabled()) { call.reject("Bluetooth is turned off"); return; }
        JSArray arr = new JSArray();
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        for (BluetoothDevice d : bonded) {
            JSObject o = new JSObject();
            o.put("name", d.getName());
            o.put("address", d.getAddress());
            arr.put(o);
        }
        JSObject res = new JSObject();
        res.put("devices", arr);
        call.resolve(res);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (needsBtPermission()) { requestPermissionForAlias("bluetooth", call, "btConnectCallback"); return; }
        doConnect(call);
    }

    @PermissionCallback
    private void btConnectCallback(PluginCall call) {
        if (needsBtPermission()) call.reject("Bluetooth permission denied");
        else doConnect(call);
    }

    @SuppressLint("MissingPermission")
    private void doConnect(final PluginCall call) {
        final String address = call.getString("address");
        if (address == null) { call.reject("address required"); return; }
        disconnectInternal();
        final BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) { call.reject("Bluetooth not available"); return; }
        new Thread(() -> {
            try {
                adapter.cancelDiscovery();
                BluetoothDevice device = adapter.getRemoteDevice(address);
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                socket.connect();
                reading = true;
                JSObject ok = new JSObject();
                ok.put("name", device.getName());
                call.resolve(ok);
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream()));
                String line;
                while (reading && (line = reader.readLine()) != null) {
                    JSObject o = new JSObject();
                    o.put("sentence", line);
                    notifyListeners("sppData", o);
                }
            } catch (Exception e) {
                if (reading) {
                    JSObject o = new JSObject();
                    o.put("error", e.getMessage());
                    notifyListeners("sppError", o);
                } else {
                    call.reject("Bluetooth connection failed: " + e.getMessage());
                }
            } finally {
                reading = false;
            }
        }).start();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        disconnectInternal();
        call.resolve();
    }

    private void disconnectInternal() {
        reading = false;
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
        socket = null;
    }

    @Override
    protected void handleOnDestroy() {
        stopStatusInternal();
        disconnectInternal();
    }
}
