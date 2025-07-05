import { spawn, ChildProcess } from 'child_process';
import { chromium, FullConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';

let pluginServerProcess: ChildProcess | null = null;

async function globalSetup(config: FullConfig) {
  console.log('🔧 Setting up plugin test environment...');

  // Install test server dependencies if needed
  const testServerDir = path.resolve(__dirname, '../test-server');
  const nodeModulesExists = fs.existsSync(path.join(testServerDir, 'node_modules'));
  
  if (!nodeModulesExists) {
    console.log('📦 Installing test server dependencies...');
    await new Promise<void>((resolve, reject) => {
      const npmInstall = spawn('npm', ['install'], {
        cwd: testServerDir,
        stdio: 'inherit',
        shell: true,
      });
      
      npmInstall.on('close', (code) => {
        if (code === 0) {
          console.log('✅ Test server dependencies installed');
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}`));
        }
      });
    });
  }

  // Start the plugin dev server
  console.log('🚀 Starting plugin dev server...');
  
  return new Promise<void>((resolve, reject) => {
    pluginServerProcess = spawn('node', ['server.js'], {
      cwd: testServerDir,
      stdio: 'pipe',
      shell: true,
    });

    let serverReady = false;

    // Handle server output
    pluginServerProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log(`[Plugin Server] ${output.trim()}`);
      
      // Check if server is ready
      if (output.includes('Plugin dev server running at')) {
        serverReady = true;
        console.log('✅ Plugin dev server ready');
        resolve();
      }
    });

    pluginServerProcess.stderr?.on('data', (data) => {
      console.error(`[Plugin Server Error] ${data.toString().trim()}`);
    });

    pluginServerProcess.on('close', (code) => {
      if (!serverReady) {
        reject(new Error(`Plugin server exited with code ${code} before becoming ready`));
      }
    });

    pluginServerProcess.on('error', (error) => {
      reject(new Error(`Failed to start plugin server: ${error.message}`));
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!serverReady) {
        reject(new Error('Plugin server failed to start within 30 seconds'));
      }
    }, 30000);
  });
}

// Store the process globally so teardown can access it
(globalThis as any).pluginServerProcess = () => pluginServerProcess;

export default globalSetup; 