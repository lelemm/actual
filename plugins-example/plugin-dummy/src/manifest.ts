import { ActualPluginManifest } from "@actual-app/plugins-core";

const manifest: ActualPluginManifest = {
  url: "https://github.com/actual-plugins/dummy/",
  name: "Dummy Plugin",
  version: "0.0.1",
  description: "Just a dummy plugin.",
  pluginType: 'client',
  minimumActualVersion: 'v25.3.0',
  author: "Leandro Menezes"
};

export default manifest;