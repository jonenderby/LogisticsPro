// The shared packages are ESM TypeScript that import siblings as "./x.js".
// Metro does not map ".js" onto ".ts" sources, so try the extensionless path first.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // fall through to the literal .js path
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
