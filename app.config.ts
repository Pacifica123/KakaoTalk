import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Relay Chat',
  slug: 'relay-chat',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  scheme: 'relaychat',
  platforms: ['android', 'web'],
  android: {
    package: 'dev.noir.relaychat',
    permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE']
  },
  web: {
    bundler: 'metro'
  }
};

export default config;
