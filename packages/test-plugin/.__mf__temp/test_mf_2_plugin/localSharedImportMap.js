
// Windows temporarily needs this file, https://github.com/module-federation/vite/issues/68

    const importMap = {
      
        "react-i18next": async () => {
          let pkg = await import("__mf__virtual/test_mf_2_plugin__prebuild__react_mf_2_i18next__prebuild__.js")
          return pkg
        }
      
    }
      const usedShared = {
      
          "react-i18next": {
            name: "react-i18next",
            version: "15.7.3",
            scope: ["default"],
            loaded: false,
            from: "test-plugin",
            async get () {
              usedShared["react-i18next"].loaded = true
              const {"react-i18next": pkgDynamicImport} = importMap 
              const res = await pkgDynamicImport()
              const exportModule = {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: true,
              requiredVersion: "^15.7.3"
            }
          }
        
    }
      const usedRemotes = [
      ]
      export {
        usedShared,
        usedRemotes
      }
      