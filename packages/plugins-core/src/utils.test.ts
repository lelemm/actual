import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useReport } from './utils';
import { PluginSpreadsheet } from './types/actualPlugin';

describe('useReport', () => {
  it('should initialize with null results', () => {
    const mockSpreadsheet = {} as PluginSpreadsheet;
    const mockGetData = vi.fn();

    const { result } = renderHook(() =>
      useReport('test-sheet', mockGetData, mockSpreadsheet)
    );

    expect(result.current).toBeNull();
  });

  it('should call getData on mount', () => {
    const mockSpreadsheet = {} as PluginSpreadsheet;
    const mockGetData = vi.fn();

    renderHook(() =>
      useReport('test-sheet', mockGetData, mockSpreadsheet)
    );

    expect(mockGetData).toHaveBeenCalledWith(
      mockSpreadsheet,
      expect.any(Function)
    );
  });

  it('should update results when getData calls setData', async () => {
    const mockSpreadsheet = {} as PluginSpreadsheet;
    const testData = { total: 1000, count: 5 };
    
    const mockGetData = vi.fn((spreadsheet, setData) => {
      // Simulate async data loading
      setTimeout(() => setData(testData), 0);
      return Promise.resolve();
    });

    const { result } = renderHook(() =>
      useReport('test-sheet', mockGetData, mockSpreadsheet)
    );

    await waitFor(() => {
      expect(result.current).toEqual(testData);
    });
  });

  it('should re-run when dependencies change', () => {
    const mockSpreadsheet1 = { id: 1 } as unknown as PluginSpreadsheet;
    const mockSpreadsheet2 = { id: 2 } as unknown as PluginSpreadsheet;
    const mockGetData = vi.fn();

    const { rerender } = renderHook(
      ({ spreadsheet }) => useReport('test-sheet', mockGetData, spreadsheet),
      { initialProps: { spreadsheet: mockSpreadsheet1 } }
    );

    expect(mockGetData).toHaveBeenCalledTimes(1);

    rerender({ spreadsheet: mockSpreadsheet2 });

    expect(mockGetData).toHaveBeenCalledTimes(2);
    expect(mockGetData).toHaveBeenLastCalledWith(
      mockSpreadsheet2,
      expect.any(Function)
    );
  });
}); 