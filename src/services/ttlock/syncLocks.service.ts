import { LockRow, LocksResp } from './types';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';

export class SyncLocksService {
    static async fetchLocks(page: number = 1, pageSize: number = 20): Promise<LocksResp> {
        const response = await fetch(`${API_BASE}/api/dashboard/locks?page=${page}&pageSize=${pageSize}`);
        
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`API ${response.status}: ${text || response.statusText}`);
        }
        
        return response.json();
    }

    static async syncLockWithTTLock(lockId: string): Promise<LockRow> {
        const response = await fetch(`${API_BASE}/api/locks/${lockId}/sync`, {
            method: 'POST',
        });
        
        if (!response.ok) {
            throw new Error(`Failed to sync lock: ${response.statusText}`);
        }
        
        return response.json();
    }
}