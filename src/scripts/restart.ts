#!/usr/bin/env node
/**
 * argos restart — restarts the Argos daemon
 *
 * macOS: launchctl kickstart -k gui/<uid>/dev.argos
 * Linux: systemctl --user restart argos
 */

import { execSync } from 'child_process';
import os from 'os';

const platform = os.platform();

try {
  if (platform === 'darwin') {
    const uid = execSync('id -u').toString().trim();
    execSync(`launchctl kickstart -k gui/${uid}/dev.argos`, { stdio: 'inherit' });
  } else if (platform === 'linux') {
    execSync('systemctl --user restart argos', { stdio: 'inherit' });
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
  console.log('Argos restarted.');
} catch (e) {
  console.error('Failed to restart Argos:', (e as Error).message);
  process.exit(1);
}
