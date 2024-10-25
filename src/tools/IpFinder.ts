import os from 'os';
import axios from 'axios';

export function getAllLocalIPAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const name in interfaces) {
    const iface = interfaces[name];
    if (!iface) continue;

    for (const alias of iface) {
      if (alias.family !== 'IPv4' || alias.internal) continue;
      addresses.push(alias.address);
    }
  }

  return addresses;
}

export function getLocalIPAddress(): string | null {
  const interfaces = os.networkInterfaces();

  for (const name in interfaces) {
    const iface = interfaces[name];
    if (!iface) continue;

    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }

  return null;
}

export async function getPublicIPAddress(): Promise<string> {
  try {
    const response = await axios.get('https://api.ipify.org', {
      params: { format: 'json' },
    });

    const ip = response.data?.ip;
    if (!ip) throw new Error('Invalid response from IP service.');

    return ip;
  } catch (error) {
    throw new Error(`Error fetching public IP address: ${error.message}`);
  }
}
