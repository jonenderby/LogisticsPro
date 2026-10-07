import { registerRootComponent } from 'expo';

import App from './App';
// Registers the background location task; it must run before any screen mounts.
import './src/state/backgroundLocation';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
