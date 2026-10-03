package io.github.tallymy;

import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {
    private long firstVolumeTap;
    private int consumedKey;

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        String choice = getSharedPreferences("tally-shortcut", MODE_PRIVATE).getString("button", "off");
        int selected = "up".equals(choice) ? KeyEvent.KEYCODE_VOLUME_UP : "down".equals(choice) ? KeyEvent.KEYCODE_VOLUME_DOWN : 0;
        int key = event.getKeyCode();
        if (event.getAction() == KeyEvent.ACTION_UP && consumedKey == key) { consumedKey = 0; return true; }
        if (selected != 0 && key == selected && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && bridge != null) {
            long now = SystemClock.elapsedRealtime();
            if (firstVolumeTap != 0 && now - firstVolumeTap <= 350) {
                firstVolumeTap = 0; consumedKey = key;
                bridge.getWebView().evaluateJavascript("window.dispatchEvent(new Event('tally:scan-shortcut'))", null);
                return true;
            }
            firstVolumeTap = now;
        } else if (event.getAction() == KeyEvent.ACTION_DOWN) firstVolumeTap = 0;
        // Single taps and long presses keep Android's normal volume behavior.
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onPause() { firstVolumeTap = 0; consumedKey = 0; super.onPause(); }
    @Override
    public void onCreate(Bundle state) {
        registerPlugin(TallyNativePlugin.class);
        super.onCreate(state);
        if (bridge == null) return;
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = super.shouldInterceptRequest(view, request);
                if (response != null && "https".equals(request.getUrl().getScheme()) && "localhost".equals(request.getUrl().getHost())) {
                    Map<String, String> headers = new HashMap<>();
                    if (response.getResponseHeaders() != null) headers.putAll(response.getResponseHeaders());
                    headers.put("Cross-Origin-Opener-Policy", "same-origin");
                    headers.put("Cross-Origin-Embedder-Policy", "credentialless");
                    response.setResponseHeaders(headers);
                }
                return response;
            }
        });
        // Bridge starts navigation during super.onCreate; ensure the first document gets the custom response policy.
        bridge.getWebView().reload();
    }
}
