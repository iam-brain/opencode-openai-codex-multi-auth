import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountManager } from '../lib/accounts.js';
import * as storage from '../lib/storage.js';

vi.mock('../lib/storage.js');

describe('AccountManager', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('removeAccountByIndex removes account and saves', async () => {
    // Setup initial accounts
    const initialAccounts = {
      version: 3,
      accounts: [
        { refreshToken: 'token1', accountId: 'id1', email: 'email1@example.com', plan: 'plus', enabled: true, addedAt: 100, lastUsed: 100 },
        { refreshToken: 'token2', accountId: 'id2', email: 'email2@example.com', plan: 'plus', enabled: true, addedAt: 200, lastUsed: 200 },
      ],
      activeIndex: 0,
      activeIndexByFamily: {},
    };

    vi.mocked(storage.loadAccounts).mockResolvedValue(initialAccounts as any);
    // Mock saveAccountsWithLock to just execute the callback
    vi.mocked(storage.saveAccountsWithLock).mockImplementation(async (cb) => {
       await cb(initialAccounts as any);
       return;
    });

    const manager = new AccountManager(undefined, initialAccounts as any);
    expect(manager.getAccountCount()).toBe(2);

    // Act
    // @ts-ignore - method not added yet
    const result = await manager.removeAccountByIndex(1); 

    // Assert
    expect(result).toBe(true);
    expect(manager.getAccountCount()).toBe(1);
    expect(manager.getAccountByIndex(0)?.email).toBe('email1@example.com');
    expect(manager.getAccountByIndex(1)).toBeNull();
    
    // Verify save was called
    expect(storage.saveAccountsWithLock).toHaveBeenCalled();
  });

  it('removeAccountByIndex does not over-remove when tokens are shared', async () => {
    // Setup initial accounts with shared refreshToken
    const initialAccounts = {
      version: 3,
      accounts: [
        { refreshToken: 'shared-token', accountId: 'id1', email: 'email1@example.com', plan: 'plus', enabled: true, addedAt: 100, lastUsed: 100 },
        { refreshToken: 'shared-token', accountId: 'id2', email: 'email2@example.com', plan: 'pro', enabled: true, addedAt: 200, lastUsed: 200 },
      ],
      activeIndex: 0,
      activeIndexByFamily: {},
    };

    let savedAccounts: any[] = [];
    vi.mocked(storage.loadAccounts).mockResolvedValue(initialAccounts as any);
    vi.mocked(storage.saveAccountsWithLock).mockImplementation(async (cb) => {
       const result = await cb(initialAccounts as any);
       savedAccounts = result.accounts;
       return;
    });

    const manager = new AccountManager(undefined, initialAccounts as any);
    expect(manager.getAccountCount()).toBe(2);

    // Act: Remove the first account
    await manager.removeAccountByIndex(0);

    // Assert: Memory state should have 1 account
    expect(manager.getAccountCount()).toBe(1);
    expect(manager.getAccountByIndex(0)?.email).toBe('email2@example.com');

    // Assert: Disk state (savedAccounts) should ALSO have 1 account
    // Currently this will FAIL because both are removed by refreshToken
    expect(savedAccounts.length).toBe(1);
    expect(savedAccounts[0].email).toBe('email2@example.com');
  });

  it('removeAccountByIndex returns false for invalid index', async () => {
     const initialAccounts = {
      version: 3,
      accounts: [
        { refreshToken: 'token1', accountId: 'id1', email: 'email1@example.com', plan: 'plus', enabled: true, addedAt: 100, lastUsed: 100 },
      ],
      activeIndex: 0,
      activeIndexByFamily: {},
    };
    vi.mocked(storage.loadAccounts).mockResolvedValue(initialAccounts as any);

    const manager = await AccountManager.loadFromDisk();
    
    // Act
    // @ts-ignore
    const result = await manager.removeAccountByIndex(5);

    // Assert
    expect(result).toBe(false);
    expect(manager.getAccountCount()).toBe(1);
  });
});
