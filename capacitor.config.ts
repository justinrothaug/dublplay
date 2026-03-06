import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dublplay.app',
  appName: 'dublplay',
  webDir: 'www',
  server: {
    url: 'https://dublplay.onrender.com',
    cleartext: false
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#0a0e1a'
  },
  plugins: {
    SocialLogin: {
      google: {
        iOSClientId: '171636644437-cphkvpt246vo1ssj2js079ii12miovv2.apps.googleusercontent.com',
        webClientId: '171636644437-ckg4kcsnuqiigkg6vu6s5je3hg8o8duj.apps.googleusercontent.com'
      }
    },
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0a0e1a',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0a0e1a'
    },
    Keyboard: {
      resize: 'native'
    }
  }
};

export default config;
