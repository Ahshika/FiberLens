import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.fiberlens.app',
  appName: 'FiberLens',
  webDir: 'dist',
  backgroundColor: '#0d1117',
  android: {
    allowMixedContent: false,
    captureInput: true,
  },
  ios: {
    contentInset: 'never',
    scrollEnabled: false,
    backgroundColor: '#0d1117',
  },
  plugins: {
    Geolocation: {},
  },
};

export default config;
