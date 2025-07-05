import { ActualPluginManifest } from "@actual-app/plugins-core";

const manifest: ActualPluginManifest = {
  url: "http://localhost:2000/",
  name: "Test Plugin",
  version: "1.0.0",
  description: "Plugin for integration testing.",
  pluginType: 'client',
  minimumActualVersion: 'v25.3.0',
  author: "Test Server"
};

export default manifest; 