import * as core from '@actions/core';
import { uploadTraces } from '../src/trace-uploader';

jest.mock('@actions/core');

const mockExistsSync = jest.fn();
const mockReaddirSync = jest.fn();
const mockReadFileSync = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readdirSync: (...args: any[]) => mockReaddirSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
  };
});

describe('uploadTraces', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should do nothing when directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await uploadTraces('/results', 'https://api.greenci.ai', 'mock-key', 'proj-1', 'run-1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should do nothing when no zip files found', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    await uploadTraces('/results', 'https://api.greenci.ai', 'mock-key', 'proj-1', 'run-1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('No trace files'));
  });

  it('should upload zip files', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([{ name: 'trace.zip', isDirectory: () => false }]);
    mockReadFileSync.mockReturnValue(Buffer.from('fake-zip-data'));
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

    await uploadTraces('/results', 'https://api.greenci.ai', 'mock-key', 'proj-1', 'run-1');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.greenci.ai/v1/traces',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-API-Key': 'mock-key' }),
      })
    );
  });

  it('should warn on upload failure', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([{ name: 'trace.zip', isDirectory: () => false }]);
    mockReadFileSync.mockReturnValue(Buffer.from('data'));
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    await uploadTraces('/results', 'https://api.greenci.ai', 'mock-key', 'proj-1', 'run-1');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Trace upload failed'));
  });

  it('should warn on fetch error', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([{ name: 'trace.zip', isDirectory: () => false }]);
    mockReadFileSync.mockReturnValue(Buffer.from('data'));
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    await uploadTraces('/results', 'https://api.greenci.ai', 'mock-key', 'proj-1', 'run-1');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Trace upload error'));
  });
});
