import { FullConfig } from '@playwright/test';

async function globalTeardown(config: FullConfig) {
  console.log('🧹 Cleaning up plugin test environment...');

  // Get the plugin server process from global storage
  const getPluginServerProcess = (globalThis as any).pluginServerProcess;
  
  if (getPluginServerProcess) {
    const pluginServerProcess = getPluginServerProcess();
    
    if (pluginServerProcess && !pluginServerProcess.killed) {
      console.log('🛑 Stopping plugin dev server...');
      
      // Try graceful shutdown first
      pluginServerProcess.kill('SIGTERM');
      
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Force kill if still running
      if (!pluginServerProcess.killed) {
        console.log('⚠️  Force stopping plugin dev server...');
        pluginServerProcess.kill('SIGKILL');
      }
      
      console.log('✅ Plugin dev server stopped');
    }
  }
  
  console.log('✅ Plugin test environment cleaned up');
}

export default globalTeardown; 